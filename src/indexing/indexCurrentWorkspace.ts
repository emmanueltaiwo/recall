import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as vscode from "vscode";
import {
  CursorStateDb,
  countChatsWithContent,
  discoverWorkspaces,
  ensureScratchDir,
  getChatMessages,
  listChatsForWorkspace,
  repairComposerDataWorkspaces,
  resolveCursorUserDataDir,
  resolveGlobalStateDb,
  resolveWorkspaceStorageDir,
  type DiscoveredWorkspace,
} from "../cursor";
import type { RecallStore } from "../store/recallStore";
import { detectCurrentWorkspace } from "../workspace/currentWorkspace";

const execFileAsync = promisify(execFile);

export interface IndexResult {
  projectId: string;
  workspaceId: string;
  chatCount: number;
  messageCount: number;
  warnings: string[];
  previousLocation?: string;
  /** Chats still associated with a previous folder path (need Restore). */
  previousChatCount: number;
  /** Chats healed after an incomplete prior Restore. */
  repairedChatCount: number;
  /** Cursor workspace id for the folder currently open (if known). */
  currentCursorWorkspaceId?: string;
}

interface HistorySource {
  cursorWorkspaceId: string;
  folderUri?: string;
  path?: string;
  /** Set when this source is a vanished previous folder location. */
  previousPath?: string;
}

export async function indexCurrentWorkspace(options: {
  store: RecallStore;
  globalStoragePath: string;
  output?: vscode.OutputChannel;
}): Promise<IndexResult> {
  const current = detectCurrentWorkspace();
  if (!current.ok) {
    throw new Error(current.message);
  }

  const warnings: string[] = [];
  const log = (msg: string) => options.output?.appendLine(msg);

  const userDataDir = resolveCursorUserDataDir({
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
  });
  const workspaceStorageDir = resolveWorkspaceStorageDir(userDataDir);
  const stateDbPath = resolveGlobalStateDb(userDataDir);

  log(`Cursor user data: ${userDataDir}`);
  log(`Indexing folder: ${current.path}`);

  const discovered = await discoverWorkspaces({ workspaceStorageDir });
  const exact = findWorkspaceForPath(discovered, current.path);

  const scratch = ensureScratchDir(options.globalStoragePath);
  let stateDb: CursorStateDb | undefined;
  let chatCount = 0;
  let messageCount = 0;
  let previousLocation: string | undefined;
  let previousChatCount = 0;
  let repairedChatCount = 0;
  let projectId = "";
  let workspaceId = "";

  try {
    // Heal incomplete prior restores before we snapshot/read the DB.
    if (exact && exact.kind === "folder") {
      try {
        const repair = repairComposerDataWorkspaces({
          globalStateDbPath: stateDbPath,
          backupRoot: join(options.globalStoragePath, "backups"),
          target: {
            cursorWorkspaceId: exact.cursorWorkspaceId,
            path: exact.path ?? current.path,
            folderUri: exact.folderUri,
          },
        });
        repairedChatCount = repair.repairedCount;
        if (repair.repairedCount > 0) {
          warnings.push(
            `Repaired ${repair.repairedCount} chat(s) so full assistant replies show in Cursor.`,
          );
          log(warnings[warnings.length - 1]!);
          if (repair.backupDir) {
            log(`Repair backup: ${repair.backupDir}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Could not repair chat workspace links: ${msg}`);
        log(warnings[warnings.length - 1]!);
      }
    }

    stateDb = CursorStateDb.open(stateDbPath, scratch);
    const schema = stateDb.checkSchema();
    if (!schema.ok) {
      throw new Error(
        `Unsupported Cursor storage schema: ${schema.errors.join("; ")}`,
      );
    }

    const sources = resolveHistorySources({
      stateDb,
      discovered,
      exact,
      currentPath: current.path,
      log,
    });

    if (sources.length === 0) {
      throw new Error(
        `No Cursor chat history found for this folder.\nOpen the folder in Cursor and start a chat, then Refresh Index.`,
      );
    }

    const previousSource = sources.find((s) => s.previousPath);
    if (previousSource?.previousPath) {
      previousLocation = previousSource.previousPath;
      warnings.push(
        `Also using history from previous location: ${previousSource.previousPath}`,
      );
      log(warnings[warnings.length - 1]!);
    }

    const gitRemote = await tryGitRemote(current.path);
    const project = options.store.upsertProjectForPath({
      name: basename(current.path),
      path: current.path,
      gitRemote,
    });
    projectId = project.id;
    options.store.clearProjectChats(project.id);

    for (const source of sources) {
      const workspace = options.store.upsertWorkspace({
        cursorWorkspaceId: source.cursorWorkspaceId,
        folderUri: source.folderUri,
        path: source.path ?? current.path,
        projectId: project.id,
      });
      if (!workspaceId || !source.previousPath) {
        workspaceId = workspace.id;
      }

      const summaries = listChatsForWorkspace(
        stateDb,
        source.cursorWorkspaceId,
      );
      log(
        `Found ${summaries.length} chat(s) with content in workspace ${source.cursorWorkspaceId}`,
      );

      let sourceChatCount = 0;
      for (const summary of summaries) {
        try {
          const messages = getChatMessages(stateDb, summary.cursorChatId);
          if (messages.length === 0) {
            continue;
          }
          options.store.replaceChatWithMessages({
            projectId: project.id,
            workspaceId: workspace.id,
            cursorChatId: summary.cursorChatId,
            title: summary.title,
            isArchived: summary.isArchived,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt,
            messages,
          });
          chatCount += 1;
          sourceChatCount += 1;
          messageCount += messages.length;
          if (source.previousPath) {
            previousChatCount += 1;
          }
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "unknown chat parse error";
          warnings.push(`Skipped chat ${summary.cursorChatId}: ${msg}`);
          log(warnings[warnings.length - 1]!);
        }
      }

      options.store.upsertWorkspace({
        cursorWorkspaceId: source.cursorWorkspaceId,
        chatCountMeta: sourceChatCount,
        projectId: project.id,
        path: source.path ?? current.path,
        folderUri: source.folderUri,
      });
      options.store.markDeepIndexed(workspace.id);
    }
  } finally {
    stateDb?.dispose();
  }

  return {
    projectId,
    workspaceId,
    chatCount,
    messageCount,
    warnings,
    previousLocation,
    previousChatCount,
    repairedChatCount,
    currentCursorWorkspaceId:
      exact && exact.kind === "folder" ? exact.cursorWorkspaceId : undefined,
  };
}

function resolveHistorySources(input: {
  stateDb: CursorStateDb;
  discovered: DiscoveredWorkspace[];
  exact: DiscoveredWorkspace | undefined;
  currentPath: string;
  log: (msg: string) => void;
}): HistorySource[] {
  const sources: HistorySource[] = [];

  if (input.exact && input.exact.kind === "folder") {
    const exactCount = countChatsWithContent(
      input.stateDb,
      input.exact.cursorWorkspaceId,
    );
    input.log(
      `Exact workspace match ${input.exact.cursorWorkspaceId} (${exactCount} chats)`,
    );
    sources.push({
      cursorWorkspaceId: input.exact.cursorWorkspaceId,
      folderUri: input.exact.folderUri,
      path: input.exact.path,
    });
  }

  const previous = findBestVanishedPrevious(input);
  if (
    previous &&
    !sources.some((s) => s.cursorWorkspaceId === previous.cursorWorkspaceId)
  ) {
    input.log(
      `Including previous location ${previous.previousPath} (${countChatsWithContent(input.stateDb, previous.cursorWorkspaceId)} chats)`,
    );
    sources.push(previous);
  }

  return sources;
}

function findBestVanishedPrevious(input: {
  stateDb: CursorStateDb;
  discovered: DiscoveredWorkspace[];
  exact: DiscoveredWorkspace | undefined;
  currentPath: string;
}): HistorySource | undefined {
  const base = basename(normalizePath(input.currentPath)).toLowerCase();
  const candidates = input.discovered.filter((w) => {
    if (w.kind !== "folder" || !w.path) {
      return false;
    }
    if (normalizePath(w.path) === normalizePath(input.currentPath)) {
      return false;
    }
    return basename(w.path).toLowerCase() === base;
  });

  let best:
    | {
        workspace: DiscoveredWorkspace;
        count: number;
      }
    | undefined;

  for (const candidate of candidates) {
    // Only treat vanished paths as "moved project" history — not live clones.
    if (!candidate.path || existsSync(candidate.path)) {
      continue;
    }
    const count = countChatsWithContent(
      input.stateDb,
      candidate.cursorWorkspaceId,
    );
    if (count === 0) {
      continue;
    }
    if (!best || count > best.count) {
      best = { workspace: candidate, count };
    }
  }

  if (!best) {
    return undefined;
  }

  return {
    cursorWorkspaceId: best.workspace.cursorWorkspaceId,
    folderUri: best.workspace.folderUri,
    path: best.workspace.path,
    previousPath: best.workspace.path,
  };
}

function findWorkspaceForPath(
  discovered: DiscoveredWorkspace[],
  folderPath: string,
) {
  const normalized = normalizePath(folderPath);
  return discovered.find(
    (w) =>
      w.kind === "folder" && w.path && normalizePath(w.path) === normalized,
  );
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, "").toLowerCase();
}

async function tryGitRemote(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd },
    );
    const remote = stdout.trim();
    return remote || undefined;
  } catch {
    return undefined;
  }
}
