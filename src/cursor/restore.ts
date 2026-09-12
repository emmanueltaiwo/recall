import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface RestoreTargetWorkspace {
  cursorWorkspaceId: string;
  path: string;
  folderUri?: string;
}

export interface RestoreResult {
  backupDir: string;
  restoredCount: number;
  composerIds: string[];
}

export function restoreComposersToWorkspace(options: {
  globalStateDbPath: string;
  workspaceStorageDir: string;
  backupRoot: string;
  composerIds: string[];
  target: RestoreTargetWorkspace;
}): RestoreResult {
  if (options.composerIds.length === 0) {
    throw new Error("No chats selected to restore");
  }
  if (!existsSync(options.globalStateDbPath)) {
    throw new Error(`Cursor state DB not found: ${options.globalStateDbPath}`);
  }

  const backupDir = createBackup(options.globalStateDbPath, options.backupRoot);
  const targetUri = buildFolderUri(options.target);

  try {
    return withSqliteRetry(options.globalStateDbPath, (db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const select = db.prepare(
          `SELECT composerId, workspaceId, value FROM composerHeaders WHERE composerId = ?`,
        );
        const update = db.prepare(
          `UPDATE composerHeaders SET workspaceId = ?, value = ? WHERE composerId = ?`,
        );
        const selectComposerData = db.prepare(
          `SELECT value FROM cursorDiskKV WHERE key = ?`,
        );
        const updateComposerData = db.prepare(
          `UPDATE cursorDiskKV SET value = ? WHERE key = ?`,
        );

        const workspaceIdentifier = {
          id: options.target.cursorWorkspaceId,
          uri: {
            $mid: 1,
            fsPath: options.target.path,
            external: targetUri,
            path: options.target.path,
            scheme: "file",
          },
        };

        const restored: string[] = [];

        for (const composerId of options.composerIds) {
          const row = select.get(composerId) as
            | {
                composerId: string;
                workspaceId: string | null;
                value: string | null;
              }
            | undefined;
          if (!row) {
            continue;
          }

          let valueJson = row.value ?? "{}";
          try {
            const value = JSON.parse(valueJson) as Record<string, unknown>;
            value.workspaceIdentifier = workspaceIdentifier;
            valueJson = JSON.stringify(value);
          } catch {
            /* keep original value if not JSON */
          }

          update.run(options.target.cursorWorkspaceId, valueJson, composerId);
          patchComposerDataWorkspace({
            selectComposerData,
            updateComposerData,
            composerId,
            workspaceIdentifier,
          });
          restored.push(composerId);
        }

        db.exec("COMMIT");

        if (restored.length === 0) {
          throw new Error(
            "None of the selected chats were found in Cursor's composerHeaders table",
          );
        }

        mergeSelectedComposers({
          workspaceStorageDir: options.workspaceStorageDir,
          targetWorkspaceId: options.target.cursorWorkspaceId,
          composerIds: restored,
        });

        return {
          backupDir,
          restoredCount: restored.length,
          composerIds: restored,
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  } catch (err) {
    throw wrapLockError(err);
  }
}

/**
 * Earlier restores only remapped composerHeaders, leaving composerData on the
 * old workspace id — Cursor then drops most assistant turns in the UI.
 * Heal any headers already pointing at `target` whose composerData still lags.
 */
export function repairComposerDataWorkspaces(options: {
  globalStateDbPath: string;
  backupRoot: string;
  target: RestoreTargetWorkspace;
}): { repairedCount: number; backupDir?: string } {
  if (!existsSync(options.globalStateDbPath)) {
    return { repairedCount: 0 };
  }

  const targetUri = buildFolderUri(options.target);
  const workspaceIdentifier = {
    id: options.target.cursorWorkspaceId,
    uri: {
      $mid: 1,
      fsPath: options.target.path,
      external: targetUri,
      path: options.target.path,
      scheme: "file",
    },
  };

  const toRepair = withSqliteRetry(options.globalStateDbPath, (db) => {
    const candidates = db
      .prepare(`SELECT composerId FROM composerHeaders WHERE workspaceId = ?`)
      .all(options.target.cursorWorkspaceId) as unknown as Array<{
      composerId: string;
    }>;
    const selectComposerData = db.prepare(
      `SELECT value FROM cursorDiskKV WHERE key = ?`,
    );
    const ids: string[] = [];
    for (const { composerId } of candidates) {
      const row = selectComposerData.get(`composerData:${composerId}`) as
        | { value: string }
        | undefined;
      if (!row?.value) {
        continue;
      }
      try {
        const data = JSON.parse(row.value) as Record<string, unknown>;
        const current = data.workspaceIdentifier as { id?: string } | undefined;
        if (current?.id === options.target.cursorWorkspaceId) {
          continue;
        }
        ids.push(composerId);
      } catch {
        /* ignore bad JSON */
      }
    }
    return ids;
  });

  if (toRepair.length === 0) {
    return { repairedCount: 0 };
  }

  const backupDir = createBackup(options.globalStateDbPath, options.backupRoot);
  let repairedCount = 0;

  try {
    withSqliteRetry(options.globalStateDbPath, (db) => {
      const selectComposerData = db.prepare(
        `SELECT value FROM cursorDiskKV WHERE key = ?`,
      );
      const updateComposerData = db.prepare(
        `UPDATE cursorDiskKV SET value = ? WHERE key = ?`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const composerId of toRepair) {
          if (
            patchComposerDataWorkspace({
              selectComposerData,
              updateComposerData,
              composerId,
              workspaceIdentifier,
            })
          ) {
            repairedCount += 1;
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  } catch (err) {
    throw wrapLockError(err);
  }

  return { repairedCount, backupDir };
}

function patchComposerDataWorkspace(options: {
  selectComposerData: { get: (key: string) => unknown };
  updateComposerData: { run: (value: string, key: string) => unknown };
  composerId: string;
  workspaceIdentifier: {
    id: string;
    uri: Record<string, unknown>;
  };
}): boolean {
  const key = `composerData:${options.composerId}`;
  const row = options.selectComposerData.get(key) as
    | { value: string }
    | undefined;
  if (!row?.value) {
    return false;
  }
  try {
    const data = JSON.parse(row.value) as Record<string, unknown>;
    const current = data.workspaceIdentifier as { id?: string } | undefined;
    if (current?.id === options.workspaceIdentifier.id) {
      return false;
    }
    data.workspaceIdentifier = options.workspaceIdentifier;
    options.updateComposerData.run(JSON.stringify(data), key);
    return true;
  } catch {
    return false;
  }
}

function createBackup(sourceDbPath: string, backupRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(backupRoot, `cursor-state-${stamp}`);
  mkdirSync(backupDir, { recursive: true });

  const dest = join(backupDir, "state.vscdb");
  copyFileSync(sourceDbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${sourceDbPath}${suffix}`;
    if (existsSync(side)) {
      copyFileSync(side, `${dest}${suffix}`);
    }
  }
  return backupDir;
}

function buildFolderUri(target: RestoreTargetWorkspace): string {
  if (target.folderUri) {
    return target.folderUri;
  }
  return pathToFileURL(target.path).href;
}

function mergeSelectedComposers(options: {
  workspaceStorageDir: string;
  targetWorkspaceId: string;
  composerIds: string[];
}): void {
  const wsDbPath = join(
    options.workspaceStorageDir,
    options.targetWorkspaceId,
    "state.vscdb",
  );
  if (!existsSync(wsDbPath)) {
    return;
  }

  const wsBackup = `${wsDbPath}.recall-backup-${Date.now()}`;
  copyFileSync(wsDbPath, wsBackup);
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${wsDbPath}${suffix}`;
    if (existsSync(side)) {
      try {
        copyFileSync(side, `${wsBackup}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  }

  withSqliteRetry(wsDbPath, (db) => {
    const row = db
      .prepare(`SELECT value FROM ItemTable WHERE key = ?`)
      .get("composer.composerData") as { value: string } | undefined;

    let data: {
      selectedComposerIds?: string[];
      lastFocusedComposerIds?: string[];
      [key: string]: unknown;
    } = {};

    if (row?.value) {
      try {
        data = JSON.parse(row.value) as typeof data;
      } catch {
        data = {};
      }
    }

    const selected = new Set(data.selectedComposerIds ?? []);
    for (const id of options.composerIds) {
      selected.add(id);
    }
    data.selectedComposerIds = [...selected];

    const focused = data.lastFocusedComposerIds ?? [];
    const primary = options.composerIds[0];
    if (primary) {
      data.lastFocusedComposerIds = [
        primary,
        ...focused.filter((id) => id !== primary),
      ].slice(0, 20);
    }

    const payload = JSON.stringify(data);
    if (row) {
      db.prepare(`UPDATE ItemTable SET value = ? WHERE key = ?`).run(
        payload,
        "composer.composerData",
      );
    } else {
      db.prepare(`INSERT INTO ItemTable(key, value) VALUES (?, ?)`).run(
        "composer.composerData",
        payload,
      );
    }
  });
}

function withSqliteRetry<T>(
  dbPath: string,
  fn: (db: DatabaseSync) => T,
  attempts = 8,
): T {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 8000;");
      return fn(db);
    } catch (err) {
      lastError = err;
      if (!isDatabaseLockedError(err) || i === attempts - 1) {
        throw err;
      }
      const waitMs = 250 * (i + 1);
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        /* wait for Cursor to release the lock */
      }
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  throw lastError;
}

function isDatabaseLockedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY|unable to open database file/i.test(
    message,
  );
}

function wrapLockError(err: unknown): Error {
  if (!isDatabaseLockedError(err)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return new Error(
    "Cursor is using its database right now (database is locked). Close other Cursor windows, wait a few seconds, and try Restore again — or reload this window and retry.",
  );
}

export function listRecentBackups(backupRoot: string): string[] {
  if (!existsSync(backupRoot)) {
    return [];
  }
  return readdirSync(backupRoot)
    .map((name) => join(backupRoot, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

export function deleteBackupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
