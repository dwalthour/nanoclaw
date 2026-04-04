/**
 * Unified session format for NanoClaw agent runners.
 * Both Claude and Ollama runners write to this format, enabling
 * future on-the-fly model switching with conversation history preserved.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface UnifiedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: UnifiedToolCall[];
  toolCallId?: string;
  timestamp: string;
  provider: 'claude' | 'ollama';
  model?: string;
}

export interface UnifiedSession {
  id: string;
  messages: UnifiedMessage[];
  createdAt: string;
  lastProvider: 'claude' | 'ollama';
}

const MAX_MESSAGES = 100;
const SESSIONS_DIR = '/workspace/group/.sessions';

function sessionPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

export function createSession(provider: 'claude' | 'ollama'): UnifiedSession {
  const id = `session-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return {
    id,
    messages: [],
    createdAt: new Date().toISOString(),
    lastProvider: provider,
  };
}

export function loadSession(sessionId: string): UnifiedSession | null {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveSession(session: UnifiedSession): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const p = sessionPath(session.id);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, p);
}

export function appendMessage(
  session: UnifiedSession,
  msg: Omit<UnifiedMessage, 'timestamp'>,
): void {
  session.messages.push({
    ...msg,
    timestamp: new Date().toISOString(),
  });
  // Cap to prevent unbounded growth
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
}

/**
 * Extract plain user text from the XML-formatted prompt.
 * NanoClaw wraps messages in: <context.../><messages><message sender="Name" time="...">text</message></messages>
 * This extracts just the message content for clean session history.
 */
export function extractUserText(prompt: string): string {
  const messageMatches = prompt.match(
    /<message[^>]*>([\s\S]*?)<\/message>/g,
  );
  if (messageMatches && messageMatches.length > 0) {
    const texts = messageMatches
      .map((m) => {
        const senderMatch = m.match(/sender="([^"]+)"/);
        const content = m.replace(/<\/?message[^>]*>/g, '').trim();
        const sender = senderMatch?.[1];
        return sender ? `${sender}: ${content}` : content;
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
  }
  // If no XML found, return as-is (plain text prompt)
  return prompt;
}

/** Convert unified session messages to Ollama /api/chat format. */
export function getMessagesForOllama(
  session: UnifiedSession,
): Array<{
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  tool_call_id?: string;
}> {
  return session.messages.map((msg) => {
    const base: {
      role: typeof msg.role;
      content: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: Record<string, unknown> };
      }>;
      tool_call_id?: string;
    } = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      base.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (msg.toolCallId) {
      base.tool_call_id = msg.toolCallId;
    }
    return base;
  });
}

/**
 * Generate a text summary of the session for context injection when switching providers.
 * Focuses on the most recent messages and extracts meaningful content from XML wrappers.
 */
export function getContextSummary(
  session: UnifiedSession,
  maxMessages = 30,
): string {
  const lines: string[] = [];

  // Focus on recent messages, skip system and tool messages
  const relevant = session.messages.filter(
    (m) => m.role !== 'system' && m.role !== 'tool' && m.content,
  );
  const recent = relevant.slice(-maxMessages);

  for (const msg of recent) {
    const prefix = msg.role === 'user' ? 'User' : 'Assistant';
    let text = msg.content;

    // Extract actual message content from XML-formatted chat context
    // Format: <message sender="Name" time="...">actual content</message>
    const messageMatches = text.match(
      /<message[^>]*>([\s\S]*?)<\/message>/g,
    );
    if (messageMatches) {
      const extracted = messageMatches
        .map((m) => {
          const content = m.replace(/<\/?message[^>]*>/g, '').trim();
          return content;
        })
        .filter(Boolean)
        .join('\n');
      if (extracted) text = extracted;
    }

    // Skip empty messages
    if (!text.trim()) continue;

    // Truncate very long individual messages
    if (text.length > 1000) {
      text = text.slice(0, 1000) + '...';
    }

    lines.push(`${prefix}: ${text}`);
  }
  return lines.join('\n\n');
}
