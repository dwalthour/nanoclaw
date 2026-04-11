import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  createFolderStateTable,
  FolderStateStore,
  populateFolderStateFromGroups,
} from './folder-state.js';
import type { RegisteredGroup } from './types.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  // Create router_state table for population test
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  createFolderStateTable(db);
  return db;
}

describe('FolderStateStore', () => {
  let db: Database.Database;
  let store: FolderStateStore;

  beforeEach(() => {
    db = createTestDb();
    store = new FolderStateStore(db);
  });

  it('get returns undefined for unknown folder', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('setContainerConfig creates row if missing', () => {
    store.setContainerConfig('test_folder', {
      modelProvider: 'claude',
      claudeModel: 'sonnet',
    });
    const state = store.get('test_folder');
    expect(state).toBeDefined();
    expect(state!.containerConfig.modelProvider).toBe('claude');
    expect(state!.containerConfig.claudeModel).toBe('sonnet');
    expect(state!.activeChannelJid).toBeNull();
  });

  it('setActiveChannel creates row if missing', () => {
    store.setActiveChannel('test_folder', 'jid@telegram');
    const state = store.get('test_folder');
    expect(state).toBeDefined();
    expect(state!.activeChannelJid).toBe('jid@telegram');
  });

  it('setContainerConfig updates existing row', () => {
    store.setContainerConfig('test_folder', { modelProvider: 'ollama' });
    store.setContainerConfig('test_folder', {
      modelProvider: 'claude',
      claudeModel: 'opus',
    });
    const state = store.get('test_folder');
    expect(state!.containerConfig.modelProvider).toBe('claude');
    expect(state!.containerConfig.claudeModel).toBe('opus');
  });

  it('setActiveChannel updates existing row', () => {
    store.setActiveChannel('test_folder', 'jid@telegram');
    store.setActiveChannel('test_folder', 'jid@signal');
    const state = store.get('test_folder');
    expect(state!.activeChannelJid).toBe('jid@signal');
  });

  it('setContainerConfig preserves activeChannelJid', () => {
    store.setActiveChannel('test_folder', 'jid@telegram');
    store.setContainerConfig('test_folder', { modelProvider: 'claude' });
    const state = store.get('test_folder');
    expect(state!.activeChannelJid).toBe('jid@telegram');
    expect(state!.containerConfig.modelProvider).toBe('claude');
  });

  it('setActiveChannel preserves containerConfig', () => {
    store.setContainerConfig('test_folder', {
      modelProvider: 'claude',
      claudeModel: 'sonnet',
    });
    store.setActiveChannel('test_folder', 'jid@signal');
    const state = store.get('test_folder');
    expect(state!.containerConfig.claudeModel).toBe('sonnet');
    expect(state!.activeChannelJid).toBe('jid@signal');
  });

  it('ensureFolder creates row only if missing', () => {
    store.setContainerConfig('test_folder', { modelProvider: 'claude' });
    store.ensureFolder('test_folder', 'new_jid');
    // Should not overwrite existing state
    const state = store.get('test_folder');
    expect(state!.containerConfig.modelProvider).toBe('claude');
  });

  it('ensureFolder creates row for new folder', () => {
    store.ensureFolder('new_folder', 'jid@telegram');
    const state = store.get('new_folder');
    expect(state).toBeDefined();
    expect(state!.activeChannelJid).toBe('jid@telegram');
  });

  it('getAll returns all folder states', () => {
    store.setContainerConfig('folder_a', { modelProvider: 'claude' });
    store.setContainerConfig('folder_b', { modelProvider: 'ollama' });
    const all = store.getAll();
    expect(all).toHaveLength(2);
    const folders = all.map((s) => s.folder).sort();
    expect(folders).toEqual(['folder_a', 'folder_b']);
  });
});

describe('populateFolderStateFromGroups', () => {
  it('populates from registered groups', () => {
    const db = createTestDb();

    // Set an active JID in router_state
    db.prepare(`INSERT INTO router_state (key, value) VALUES (?, ?)`).run(
      'active_jid:telegram_main',
      'jid@telegram',
    );

    const groups: Record<string, RegisteredGroup> = {
      'jid@telegram': {
        name: 'Main',
        folder: 'telegram_main',
        trigger: 'elara',
        added_at: '2025-01-01',
        containerConfig: { modelProvider: 'claude', claudeModel: 'sonnet' },
      },
      'jid@signal': {
        name: 'Main Signal',
        folder: 'telegram_main',
        trigger: 'elara',
        added_at: '2025-01-01',
        containerConfig: undefined, // No config on sibling
      },
    };

    populateFolderStateFromGroups(db, groups);

    const store = new FolderStateStore(db);
    const state = store.get('telegram_main');
    expect(state).toBeDefined();
    expect(state!.activeChannelJid).toBe('jid@telegram');
    expect(state!.containerConfig.modelProvider).toBe('claude');
    expect(state!.containerConfig.claudeModel).toBe('sonnet');
  });

  it('does not overwrite existing rows', () => {
    const db = createTestDb();
    const store = new FolderStateStore(db);

    // Pre-populate with existing state
    store.setContainerConfig('telegram_main', {
      modelProvider: 'ollama',
      ollamaModel: 'glm-5:cloud',
    });

    const groups: Record<string, RegisteredGroup> = {
      'jid@telegram': {
        name: 'Main',
        folder: 'telegram_main',
        trigger: 'elara',
        added_at: '2025-01-01',
        containerConfig: { modelProvider: 'claude' },
      },
    };

    populateFolderStateFromGroups(db, groups);

    // Should NOT overwrite
    const state = store.get('telegram_main');
    expect(state!.containerConfig.modelProvider).toBe('ollama');
  });
});
