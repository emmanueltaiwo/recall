import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CursorSchemaSupport } from "./types";

export const PARSER_VERSION = "1";

export class CursorStateDb {
  readonly dbPath: string;
  readonly db: DatabaseSync;
  private readonly tempDir: string | undefined;

  private constructor(
    db: DatabaseSync,
    dbPath: string,
    tempDir: string | undefined,
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.tempDir = tempDir;
  }

  static open(sourceDbPath: string, scratchDir: string): CursorStateDb {
    if (!existsSync(sourceDbPath)) {
      throw new Error(`Cursor state database not found: ${sourceDbPath}`);
    }

    const tempDir = join(scratchDir, `cursor-snap-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });

    const dest = join(tempDir, "state.vscdb");
    copyFileSync(sourceDbPath, dest);

    for (const suffix of ["-wal", "-shm"]) {
      const side = `${sourceDbPath}${suffix}`;
      if (existsSync(side)) {
        try {
          copyFileSync(side, `${dest}${suffix}`);
        } catch {
          /* ignore companion copy failures */
        }
      }
    }

    const db = new DatabaseSync(dest, { readOnly: true });
    return new CursorStateDb(db, dest, tempDir);
  }

  checkSchema(): CursorSchemaSupport {
    const errors: string[] = [];
    try {
      const tables = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('composerHeaders','cursorDiskKV')`,
        )
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((t) => t.name));
      if (!names.has("composerHeaders")) {
        errors.push("missing composerHeaders table");
      }
      if (!names.has("cursorDiskKV")) {
        errors.push("missing cursorDiskKV table");
      }
    } catch (err) {
      errors.push(
        err instanceof Error ? err.message : "failed to inspect schema",
      );
    }

    return {
      ok: errors.length === 0,
      parserVersion: PARSER_VERSION,
      errors,
    };
  }

  dispose(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export function ensureScratchDir(base: string): string {
  const dir = join(base, "snapshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}
