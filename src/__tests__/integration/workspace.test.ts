import { DatabaseManager } from '../../utils/database';
import { ContextRepository } from '../../repositories/ContextRepository';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

describe('Workspace Feature Tests', () => {
  let dbManager: DatabaseManager;
  let tempDbPath: string;
  let db: any;
  let contextRepo: ContextRepository;
  let sessionId: string;
  let otherSessionId: string;

  beforeEach(() => {
    tempDbPath = path.join(os.tmpdir(), `test-workspace-${Date.now()}.db`);
    dbManager = new DatabaseManager({
      filename: tempDbPath,
      maxSize: 10 * 1024 * 1024,
      walMode: true,
    });
    db = dbManager.getDatabase();
    contextRepo = new ContextRepository(dbManager);

    sessionId = uuidv4();
    otherSessionId = uuidv4();

    db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(sessionId, 'Main Session');
    db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(
      otherSessionId,
      'Other Session'
    );
  });

  afterEach(() => {
    dbManager.close();
    try {
      fs.unlinkSync(tempDbPath);
      fs.unlinkSync(`${tempDbPath}-wal`);
      fs.unlinkSync(`${tempDbPath}-shm`);
    } catch (_e) {
      // Ignore
    }
  });

  describe('workspace column exists', () => {
    it('should have workspace column in context_items table', () => {
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('context_items')")
        .all() as any[];
      const colNames = columns.map((c: any) => c.name);
      expect(colNames).toContain('workspace');
    });
  });

  describe('saving items with workspace', () => {
    it('should save item with explicit workspace', () => {
      const item = contextRepo.save(sessionId, {
        key: 'project_config',
        value: 'Config for project A',
        workspace: '/home/user/projects/project-a',
      });

      expect(item.workspace).toBe('/home/user/projects/project-a');
    });

    it('should fall back to session working_directory when no workspace specified', () => {
      // Update session with working_directory
      db.prepare('UPDATE sessions SET working_directory = ? WHERE id = ?').run(
        '/home/user/my-project',
        sessionId
      );

      const item = contextRepo.save(sessionId, {
        key: 'auto_workspace_key',
        value: 'Should inherit workspace from session',
      });

      expect(item.workspace).toBe('/home/user/my-project');
    });

    it('should have null workspace when no workspace or working_directory set', () => {
      const item = contextRepo.save(sessionId, {
        key: 'no_workspace_key',
        value: 'No workspace',
      });

      expect(item.workspace).toBeNull();
    });
  });

  describe('searchEnhanced with workspace', () => {
    beforeEach(() => {
      // Items for workspace A
      contextRepo.save(sessionId, {
        key: 'auth_config',
        value: 'Auth configuration',
        workspace: '/projects/project-a',
      });
      contextRepo.save(sessionId, {
        key: 'db_config',
        value: 'Database configuration',
        workspace: '/projects/project-a',
      });

      // Item for workspace B
      contextRepo.save(sessionId, {
        key: 'api_config',
        value: 'API configuration',
        workspace: '/projects/project-b',
      });

      // Item with no workspace
      contextRepo.save(sessionId, {
        key: 'global_config',
        value: 'Global configuration',
      });
    });

    it('should prioritize workspace items first when workspace specified', () => {
      const result = contextRepo.searchEnhanced({
        query: 'configuration',
        sessionId,
        workspace: '/projects/project-a',
      });

      expect(result.items.length).toBe(4);
      // First two items should be from workspace A
      expect(result.items[0].workspace).toBe('/projects/project-a');
      expect(result.items[1].workspace).toBe('/projects/project-a');
    });

    it('should return only workspace items when workspaceOnly is true', () => {
      const result = contextRepo.searchEnhanced({
        query: 'configuration',
        sessionId,
        workspace: '/projects/project-a',
        workspaceOnly: true,
      });

      expect(result.items.length).toBe(2);
      expect(result.items.every(item => item.workspace === '/projects/project-a')).toBe(true);
    });

    it('should return all items when workspace not specified', () => {
      const result = contextRepo.searchEnhanced({
        query: 'configuration',
        sessionId,
      });

      expect(result.items.length).toBe(4);
    });

    it('should return zero items when workspaceOnly with non-matching workspace', () => {
      const result = contextRepo.searchEnhanced({
        query: 'configuration',
        sessionId,
        workspace: '/projects/project-c',
        workspaceOnly: true,
      });

      expect(result.items.length).toBe(0);
    });
  });

  describe('queryEnhanced with workspace', () => {
    beforeEach(() => {
      contextRepo.save(sessionId, {
        key: 'ws_item_1',
        value: 'Item 1 in workspace',
        workspace: '/projects/my-project',
      });
      contextRepo.save(sessionId, {
        key: 'ws_item_2',
        value: 'Item 2 in workspace',
        workspace: '/projects/my-project',
      });
      contextRepo.save(sessionId, {
        key: 'other_item',
        value: 'Item in other workspace',
        workspace: '/projects/other',
      });
    });

    it('should prioritize workspace items first', () => {
      const result = contextRepo.queryEnhanced({
        sessionId,
        workspace: '/projects/my-project',
      });

      expect(result.items.length).toBe(3);
      expect(result.items[0].workspace).toBe('/projects/my-project');
      expect(result.items[1].workspace).toBe('/projects/my-project');
    });

    it('should filter to only workspace items when workspaceOnly is true', () => {
      const result = contextRepo.queryEnhanced({
        sessionId,
        workspace: '/projects/my-project',
        workspaceOnly: true,
      });

      expect(result.items.length).toBe(2);
      expect(result.items.every(item => item.workspace === '/projects/my-project')).toBe(true);
    });
  });

  describe('searchAcrossSessionsEnhanced with workspace', () => {
    beforeEach(() => {
      // Items in session 1 with workspace
      contextRepo.save(sessionId, {
        key: 'session1_ws_item',
        value: 'Session 1 workspace item',
        workspace: '/projects/shared-project',
      });

      // Items in session 2 with workspace
      contextRepo.save(otherSessionId, {
        key: 'session2_ws_item',
        value: 'Session 2 workspace item',
        workspace: '/projects/shared-project',
      });

      // Item with different workspace
      contextRepo.save(sessionId, {
        key: 'different_ws_item',
        value: 'Different workspace item',
        workspace: '/projects/other',
      });
    });

    it('should prioritize workspace items first in cross-session search', () => {
      const result = contextRepo.searchAcrossSessionsEnhanced({
        query: 'item',
        currentSessionId: sessionId,
        workspace: '/projects/shared-project',
      });

      expect(result.items.length).toBe(3);
      // First two should be workspace items
      expect(result.items[0].workspace).toBe('/projects/shared-project');
      expect(result.items[1].workspace).toBe('/projects/shared-project');
    });

    it('should return only workspace items when workspaceOnly is true in cross-session search', () => {
      const result = contextRepo.searchAcrossSessionsEnhanced({
        query: 'item',
        currentSessionId: sessionId,
        workspace: '/projects/shared-project',
        workspaceOnly: true,
      });

      expect(result.items.length).toBe(2);
      expect(result.items.every(item => item.workspace === '/projects/shared-project')).toBe(true);
    });
  });
});
