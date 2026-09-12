import { basename } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import * as vscode from "vscode";
import {
  discoverWorkspaces,
  resolveCursorUserDataDir,
  resolveGlobalStateDb,
  resolveWorkspaceStorageDir,
  restoreComposersToWorkspace,
} from "../cursor";
import type { Chat } from "../domain/types";
import type { RecallStore } from "../store/recallStore";
import { detectCurrentWorkspace } from "../workspace/currentWorkspace";

export async function restoreChatsIntoCursor(options: {
  store: RecallStore;
  globalStoragePath: string;
  chats: Chat[];
  output?: vscode.OutputChannel;
}): Promise<{ restoredCount: number; backupDir: string }> {
  if (options.chats.length === 0) {
    throw new Error("No chats to restore");
  }

  const current = detectCurrentWorkspace();
  if (!current.ok) {
    throw new Error(current.message);
  }

  const userDataDir = resolveCursorUserDataDir({
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
  });
  const workspaceStorageDir = resolveWorkspaceStorageDir(userDataDir);
  const globalStateDbPath = resolveGlobalStateDb(userDataDir);

  const discovered = await discoverWorkspaces({ workspaceStorageDir });
  const normalized = current.path.replace(/\/+$/, "").toLowerCase();
  const target = discovered.find(
    (w) =>
      w.kind === "folder" &&
      w.path &&
      w.path.replace(/\/+$/, "").toLowerCase() === normalized,
  );

  if (!target || target.kind !== "folder") {
    throw new Error(
      "Could not find Cursor workspaceStorage for this folder. Open the folder in Cursor once, then try again.",
    );
  }

  const composerIds = options.chats.map((c) => c.cursorChatId);
  options.output?.appendLine(
    `Restoring ${composerIds.length} chat(s) → workspace ${target.cursorWorkspaceId} (${target.path})`,
  );

  const backupRoot = join(options.globalStoragePath, "backups");
  const result = restoreComposersToWorkspace({
    globalStateDbPath,
    workspaceStorageDir,
    backupRoot,
    composerIds,
    target: {
      cursorWorkspaceId: target.cursorWorkspaceId,
      path: target.path ?? current.path,
      folderUri: target.folderUri,
    },
  });

  options.output?.appendLine(
    `Restored ${result.restoredCount} chat(s). Backup: ${result.backupDir}`,
  );
  options.output?.appendLine(
    `Project: ${basename(current.path)}. Fully quit Cursor (Cmd+Q) and reopen this folder for chats to appear.`,
  );

  return {
    restoredCount: result.restoredCount,
    backupDir: result.backupDir,
  };
}
