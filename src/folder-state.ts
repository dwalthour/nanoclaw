/**
 * FolderStateStore — Centralized per-folder state management.
 *
 * Replaces the pattern of scattering per-folder state (containerConfig,
 * activeChannelJid) across per-JID rows in registered_groups. Every
 * read site asks the same store; every write site goes through the same
 * mutators. No iteration order races, no stale rows, no fragmentation.
 */
import type Database from 'better-sqlite3';

import { logger } from './logger.js';
import type { ContainerConfig, RegisteredGroup } from './types.js';

export interface FolderState {
  folder: string;
  activeChannelJid: string | null;
  containerConfig: ContainerConfig;
  updatedAt: number; // Unix ms
}

/**
 * Create the folder_state table if it doesn't exist.
 * Called from createSchema() in db.ts during startup.
 */
export function createFolderStateTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS folder_state (
      folder TEXT PRIMARY KEY,
      active_channel_jid TEXT,
      container_config TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Populate folder_state from existing registered_groups rows.
 * For each unique folder, picks the "best" containerConfig available
 * (preferring non-null configs) and the most recently used activeChannelJid
 * from router_state. Only inserts rows that don't already exist — safe to
 * call on every startup.
 */
export function populateFolderStateFromGroups(
  database: Database.Database,
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  // Collect unique folders and their best configs
  const folderConfigs = new Map<string, ContainerConfig>();
  const folderJids = new Map<string, string[]>();

  for (const [jid, group] of Object.entries(registeredGroups)) {
    const existing = folderConfigs.get(group.folder);
    if (!existing && group.containerConfig) {
      folderConfigs.set(group.folder, group.containerConfig);
    }
    const jids = folderJids.get(group.folder) || [];
    jids.push(jid);
    folderJids.set(group.folder, jids);
  }

  // Read active channel JIDs from router_state (existing key pattern: active_jid:<folder>)
  const activeJids = new Map<string, string>();
  try {
    const rows = database
      .prepare(
        `SELECT key, value FROM router_state WHERE key LIKE 'active_jid:%'`,
      )
      .all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      const folder = row.key.replace('active_jid:', '');
      activeJids.set(folder, row.value);
    }
  } catch {
    // router_state might not exist yet
  }

  const insertStmt = database.prepare(`
    INSERT OR IGNORE INTO folder_state (folder, active_channel_jid, container_config, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  const now = Date.now();
  let populated = 0;
  for (const [folder, jids] of folderJids) {
    const config = folderConfigs.get(folder) || {};
    const activeJid = activeJids.get(folder) || jids[0] || null;
    const result = insertStmt.run(
      folder,
      activeJid,
      JSON.stringify(config),
      now,
    );
    if (result.changes > 0) populated++;
  }

  if (populated > 0) {
    logger.info(
      { populated, total: folderJids.size },
      'Populated folder_state from registered_groups',
    );
  }
}

export class FolderStateStore {
  private db: Database.Database;

  constructor(database: Database.Database) {
    this.db = database;
  }

  /**
   * Get the canonical state for a folder. Returns undefined if the folder
   * has no state yet (shouldn't happen after population, but safe to handle).
   */
  get(folder: string): FolderState | undefined {
    const row = this.db
      .prepare('SELECT * FROM folder_state WHERE folder = ?')
      .get(folder) as
      | {
          folder: string;
          active_channel_jid: string | null;
          container_config: string | null;
          updated_at: number;
        }
      | undefined;

    if (!row) return undefined;

    return {
      folder: row.folder,
      activeChannelJid: row.active_channel_jid,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : {},
      updatedAt: row.updated_at,
    };
  }

  /**
   * Set or update the active channel JID for a folder.
   */
  setActiveChannel(folder: string, jid: string): void {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE folder_state SET active_channel_jid = ?, updated_at = ? WHERE folder = ?`,
      )
      .run(jid, now, folder);

    if (result.changes === 0) {
      // Row doesn't exist yet — create it with empty config
      this.db
        .prepare(
          `INSERT INTO folder_state (folder, active_channel_jid, container_config, updated_at)
         VALUES (?, ?, ?, ?)`,
        )
        .run(folder, jid, '{}', now);
    }

    logger.debug({ folder, jid }, 'FolderState: active channel updated');
  }

  /**
   * Set or update the container config for a folder.
   */
  setContainerConfig(folder: string, config: ContainerConfig): void {
    const now = Date.now();
    const configJson = JSON.stringify(config);
    const result = this.db
      .prepare(
        `UPDATE folder_state SET container_config = ?, updated_at = ? WHERE folder = ?`,
      )
      .run(configJson, now, folder);

    if (result.changes === 0) {
      // Row doesn't exist yet — create with no active channel
      this.db
        .prepare(
          `INSERT INTO folder_state (folder, active_channel_jid, container_config, updated_at)
         VALUES (?, ?, ?, ?)`,
        )
        .run(folder, null, configJson, now);
    }

    logger.debug({ folder }, 'FolderState: container config updated');
  }

  /**
   * Ensure a folder has a row in folder_state. Called when a new group is
   * registered to keep folder_state in sync. No-op if the row already exists.
   */
  ensureFolder(folder: string, initialJid?: string): void {
    const existing = this.get(folder);
    if (existing) return;

    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO folder_state (folder, active_channel_jid, container_config, updated_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(folder, initialJid || null, '{}', now);

    logger.debug(
      { folder, initialJid },
      'FolderState: created initial state for new folder',
    );
  }

  /**
   * Get all folder states. Used for diagnostics.
   */
  getAll(): FolderState[] {
    const rows = this.db.prepare('SELECT * FROM folder_state').all() as Array<{
      folder: string;
      active_channel_jid: string | null;
      container_config: string | null;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      folder: row.folder,
      activeChannelJid: row.active_channel_jid,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : {},
      updatedAt: row.updated_at,
    }));
  }
}
