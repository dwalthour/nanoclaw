import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import path from 'path';
import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_OLLAMA_MODEL,
  HEARTBEAT_QUIET_PERIOD_MS,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getLastMessageTimestamp,
  getTaskById,
  getRouterState,
  logTaskRun,
  storeMessage,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  getUnifiedSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupFolder: string,
    proc: ChildProcess,
    containerName: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  /**
   * Switch the model provider/model for a JID's folder. Used by the heartbeat
   * loop to downshift to a cheap Ollama model before firing a heartbeat while
   * the folder is on a premium Claude model. `opts.silent` suppresses the
   * user-visible channel notification.
   */
  switchModel: (
    jid: string,
    provider: 'claude' | 'ollama',
    modelName?: string,
    opts?: { silent?: boolean },
  ) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;
  const unifiedSessions = deps.getUnifiedSessions();
  const unifiedSessionId =
    task.context_mode === 'group'
      ? unifiedSessions[task.group_folder]
      : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.group_folder);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        modelProvider: group.containerConfig?.modelProvider,
        claudeModel: group.containerConfig?.claudeModel,
        ollamaModel: group.containerConfig?.ollamaModel,
        unifiedSessionId,
      },
      (proc, containerName) =>
        deps.onProcess(task.group_folder, proc, containerName),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Check if there's an active channel from recent messages
          // (for unified sessions where multiple channels share one folder)
          const activeJidKey = `active_jid:${task.group_folder}`;
          const activeJid = getRouterState(activeJidKey) || task.chat_jid;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(activeJid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.group_folder);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  // Track last heartbeat time per group (init to now so we don't fire on startup)
  const lastHeartbeat: Record<string, number> = {};
  const startupTime = Date.now();

  const checkHeartbeats = async () => {
    const groups = deps.registeredGroups();

    // Group JIDs by folder to avoid duplicate heartbeats for multi-channel groups
    const folders = new Map<
      string,
      { jids: string[]; group: RegisteredGroup }
    >();
    for (const [jid, group] of Object.entries(groups)) {
      const folder = group.folder;
      if (!folders.has(folder)) {
        folders.set(folder, { jids: [], group });
      }
      folders.get(folder)!.jids.push(jid);
    }

    for (const [folder, { jids, group }] of folders) {
      const heartbeatPath = path.join(GROUPS_DIR, folder, 'HEARTBEAT.md');
      if (!fs.existsSync(heartbeatPath)) continue;

      const now = Date.now();
      const lastBeat = lastHeartbeat[folder] || startupTime;
      if (now - lastBeat < HEARTBEAT_INTERVAL) continue;

      // Determine which JID to send heartbeat to
      // For multi-channel groups, use the active channel from router state
      const activeJidKey = `active_jid:${folder}`;
      const activeJid = getRouterState(activeJidKey) || jids[0];

      // Skip if there has been recent direct interaction (user messages only, not heartbeats/bot)
      const lastMsg = getLastMessageTimestamp(activeJid, { userOnly: true });
      if (lastMsg) {
        const lastMsgAge = now - new Date(lastMsg).getTime();
        if (lastMsgAge < HEARTBEAT_QUIET_PERIOD_MS) {
          logger.debug(
            { group: group.name, lastMsgAge },
            'Skipping heartbeat — recent interaction',
          );
          continue;
        }
      }

      lastHeartbeat[folder] = now;

      // Downshift to a cheap Ollama model before firing the heartbeat if the
      // folder is currently on a Claude model. Heartbeats are frequent and
      // don't need premium reasoning; Ollama usage is effectively free by
      // comparison. Dave can manually `/model` back to Claude when he wants.
      const currentProvider = group.containerConfig?.modelProvider || 'claude';
      if (currentProvider === 'claude') {
        try {
          await deps.switchModel(activeJid, 'ollama', HEARTBEAT_OLLAMA_MODEL, {
            silent: true,
          });
          logger.info(
            { group: group.name, folder, model: HEARTBEAT_OLLAMA_MODEL },
            'Heartbeat auto-switched from Claude to Ollama',
          );
        } catch (err) {
          logger.error(
            { err, group: group.name, folder },
            'Heartbeat auto-switch failed, proceeding on current model',
          );
        }
      }

      try {
        const heartbeatContent = fs.readFileSync(heartbeatPath, 'utf-8').trim();
        if (!heartbeatContent) continue;

        const prompt = `[HEARTBEAT — This is an automated periodic check-in, not a user message.]\n\nYou MUST respond ONLY in English. Never use Chinese or any other language. All output must be in English.\n\n${heartbeatContent}\n\nStart your response with: Heartbeat status`;

        // Try to pipe into the active container first
        if (deps.queue.sendMessage(activeJid, prompt)) {
          logger.info(
            { group: group.name, folder, activeJid },
            'Heartbeat piped to active container',
          );
          continue;
        }

        // No active container — store as a synthetic message so the normal
        // message processing loop picks it up and spawns a container.
        logger.info(
          { group: group.name, folder, activeJid },
          'Heartbeat spawning new container',
        );
        storeMessage({
          id: `heartbeat-${Date.now()}`,
          chat_jid: activeJid,
          sender: '[System]',
          sender_name: '[System]',
          content: prompt,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        });
        deps.queue.enqueueMessageCheck(activeJid);
      } catch (err) {
        logger.error({ err, group: group.name }, 'Error processing heartbeat');
      }
    }
  };

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }

      // Check heartbeats
      await checkHeartbeats();
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
