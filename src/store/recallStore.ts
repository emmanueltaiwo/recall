import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Chat, Message, Project, Workspace } from "../domain/types";

const SCHEMA_VERSION = "1";

export class RecallStore {
  readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        git_remote TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_paths (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(project_id, path)
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        cursor_workspace_id TEXT NOT NULL UNIQUE,
        folder_uri TEXT,
        path TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        last_discovered_at INTEGER NOT NULL,
        deep_indexed_at INTEGER,
        chat_count_meta INTEGER,
        dismissed_candidate INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        cursor_chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL,
        character_count INTEGER NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        content_hash TEXT,
        UNIQUE(workspace_id, cursor_chat_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        cursor_message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at INTEGER,
        UNIQUE(chat_id, cursor_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_paths_path ON project_paths(path);
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        chat_id UNINDEXED,
        project_id UNINDEXED,
        title,
        content,
        tokenize = 'porter unicode61'
      );
    `);

    this.setMeta("schema_version", SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  upsertProjectForPath(input: {
    name: string;
    path: string;
    gitRemote?: string;
  }): Project {
    const now = Date.now();
    const existingPath = this.db
      .prepare(
        `SELECT p.id, p.name, p.git_remote, p.created_at, p.updated_at
         FROM project_paths pp
         JOIN projects p ON p.id = pp.project_id
         WHERE pp.path = ?`,
      )
      .get(input.path) as
      | {
          id: string;
          name: string;
          git_remote: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;

    if (existingPath) {
      this.db
        .prepare(
          `UPDATE projects SET name = ?, git_remote = COALESCE(?, git_remote), updated_at = ? WHERE id = ?`,
        )
        .run(input.name, input.gitRemote ?? null, now, existingPath.id);
      this.db
        .prepare(
          `UPDATE project_paths SET last_seen_at = ? WHERE project_id = ? AND path = ?`,
        )
        .run(now, existingPath.id, input.path);
      return {
        id: existingPath.id,
        name: input.name,
        gitRemote: input.gitRemote ?? existingPath.git_remote ?? undefined,
        createdAt: existingPath.created_at,
        updatedAt: now,
      };
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO projects(id, name, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.gitRemote ?? null, now, now);
    this.db
      .prepare(
        `INSERT INTO project_paths(id, project_id, path, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), id, input.path, now, now);

    return {
      id,
      name: input.name,
      gitRemote: input.gitRemote,
      createdAt: now,
      updatedAt: now,
    };
  }

  getProject(id: string): Project | undefined {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as
      | {
          id: string;
          name: string;
          git_remote: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      name: row.name,
      gitRemote: row.git_remote ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertWorkspace(input: {
    cursorWorkspaceId: string;
    folderUri?: string;
    path?: string;
    projectId?: string;
    chatCountMeta?: number;
  }): Workspace {
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT id FROM workspaces WHERE cursor_workspace_id = ?`)
      .get(input.cursorWorkspaceId) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE workspaces
           SET folder_uri = COALESCE(?, folder_uri),
               path = COALESCE(?, path),
               project_id = COALESCE(?, project_id),
               last_discovered_at = ?,
               chat_count_meta = COALESCE(?, chat_count_meta)
           WHERE id = ?`,
        )
        .run(
          input.folderUri ?? null,
          input.path ?? null,
          input.projectId ?? null,
          now,
          input.chatCountMeta ?? null,
          existing.id,
        );
      return this.getWorkspace(existing.id)!;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO workspaces(
          id, cursor_workspace_id, folder_uri, path, project_id,
          last_discovered_at, chat_count_meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.cursorWorkspaceId,
        input.folderUri ?? null,
        input.path ?? null,
        input.projectId ?? null,
        now,
        input.chatCountMeta ?? null,
      );
    return this.getWorkspace(id)!;
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db
      .prepare(`SELECT * FROM workspaces WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapWorkspace(row) : undefined;
  }

  markDeepIndexed(workspaceId: string): void {
    this.db
      .prepare(`UPDATE workspaces SET deep_indexed_at = ? WHERE id = ?`)
      .run(Date.now(), workspaceId);
  }

  replaceChatWithMessages(input: {
    projectId?: string;
    workspaceId: string;
    cursorChatId: string;
    title: string;
    isArchived: boolean;
    createdAt?: number;
    updatedAt?: number;
    messages: Array<{
      cursorMessageId: string;
      role: Message["role"];
      content: string;
      createdAt?: number;
    }>;
  }): Chat {
    const characterCount = input.messages.reduce(
      (sum, m) => sum + m.content.length,
      0,
    );
    const contentHash = createHash("sha256")
      .update(
        input.messages
          .map((m) => `${m.cursorMessageId}:${m.role}:${m.content}`)
          .join("\n"),
      )
      .digest("hex");

    const existing = this.db
      .prepare(
        `SELECT id FROM chats WHERE workspace_id = ? AND cursor_chat_id = ?`,
      )
      .get(input.workspaceId, input.cursorChatId) as { id: string } | undefined;

    const chatId = existing?.id ?? randomUUID();

    this.db.exec("BEGIN");
    try {
      if (existing) {
        this.db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(chatId);
        this.db
          .prepare(`DELETE FROM messages_fts WHERE chat_id = ?`)
          .run(chatId);
        this.db
          .prepare(
            `UPDATE chats SET
              project_id = ?, title = ?, is_archived = ?, message_count = ?,
              character_count = ?, created_at = ?, updated_at = ?, content_hash = ?
             WHERE id = ?`,
          )
          .run(
            input.projectId ?? null,
            input.title,
            input.isArchived ? 1 : 0,
            input.messages.length,
            characterCount,
            input.createdAt ?? null,
            input.updatedAt ?? null,
            contentHash,
            chatId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO chats(
              id, project_id, workspace_id, cursor_chat_id, title, is_archived,
              message_count, character_count, created_at, updated_at, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chatId,
            input.projectId ?? null,
            input.workspaceId,
            input.cursorChatId,
            input.title,
            input.isArchived ? 1 : 0,
            input.messages.length,
            characterCount,
            input.createdAt ?? null,
            input.updatedAt ?? null,
            contentHash,
          );
      }

      const insertMsg = this.db.prepare(
        `INSERT INTO messages(id, chat_id, cursor_message_id, role, content, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.db.prepare(
        `INSERT INTO messages_fts(chat_id, project_id, title, content) VALUES (?, ?, ?, ?)`,
      );

      input.messages.forEach((m, index) => {
        insertMsg.run(
          randomUUID(),
          chatId,
          m.cursorMessageId,
          m.role,
          m.content,
          index,
          m.createdAt ?? null,
        );
        insertFts.run(chatId, input.projectId ?? "", input.title, m.content);
      });

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return this.getChat(chatId)!;
  }

  clearProjectChats(projectId: string): void {
    const chats = this.db
      .prepare(`SELECT id FROM chats WHERE project_id = ?`)
      .all(projectId) as unknown as Array<{ id: string }>;
    this.db.exec("BEGIN");
    try {
      for (const chat of chats) {
        this.db
          .prepare(`DELETE FROM messages_fts WHERE chat_id = ?`)
          .run(chat.id);
        this.db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(chat.id);
        this.db.prepare(`DELETE FROM chats WHERE id = ?`).run(chat.id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listChatsForProject(projectId: string): Chat[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chats WHERE project_id = ? ORDER BY COALESCE(updated_at, created_at, 0) DESC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(mapChat);
  }

  getChat(id: string): Chat | undefined {
    const row = this.db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapChat(row) : undefined;
  }

  getMessages(chatId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY sequence ASC`)
      .all(chatId) as Array<Record<string, unknown>>;
    return rows.map(mapMessage);
  }

  searchChats(query: string, projectId?: string): Chat[] {
    const q = query.trim();
    if (!q) {
      return projectId ? this.listChatsForProject(projectId) : [];
    }

    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT DISTINCT c.*
             FROM messages_fts f
             JOIN chats c ON c.id = f.chat_id
             WHERE messages_fts MATCH ? AND f.project_id = ?
             ORDER BY COALESCE(c.updated_at, c.created_at, 0) DESC
             LIMIT 100`,
          )
          .all(q, projectId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT DISTINCT c.*
             FROM messages_fts f
             JOIN chats c ON c.id = f.chat_id
             WHERE messages_fts MATCH ?
             ORDER BY COALESCE(c.updated_at, c.created_at, 0) DESC
             LIMIT 100`,
          )
          .all(q) as Array<Record<string, unknown>>);

    return rows.map(mapChat);
  }
}

function mapWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    cursorWorkspaceId: String(row.cursor_workspace_id),
    folderUri: row.folder_uri ? String(row.folder_uri) : undefined,
    path: row.path ? String(row.path) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    lastDiscoveredAt: Number(row.last_discovered_at),
    deepIndexedAt: row.deep_indexed_at
      ? Number(row.deep_indexed_at)
      : undefined,
    chatCountMeta:
      row.chat_count_meta === null || row.chat_count_meta === undefined
        ? undefined
        : Number(row.chat_count_meta),
  };
}

function mapChat(row: Record<string, unknown>): Chat {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    workspaceId: String(row.workspace_id),
    cursorChatId: String(row.cursor_chat_id),
    title: String(row.title),
    isArchived: Number(row.is_archived) === 1,
    messageCount: Number(row.message_count),
    characterCount: Number(row.character_count),
    createdAt: row.created_at ? Number(row.created_at) : undefined,
    updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
    contentHash: row.content_hash ? String(row.content_hash) : undefined,
  };
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    cursorMessageId: String(row.cursor_message_id),
    role: row.role as Message["role"],
    content: String(row.content),
    sequence: Number(row.sequence),
    createdAt: row.created_at ? Number(row.created_at) : undefined,
  };
}

export function recallDbPath(globalStoragePath: string): string {
  return join(globalStoragePath, "recall.db");
}
