import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
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
  let projectId = "";
  let workspaceId = "";

  try {
    stateDb = CursorStateDb.open(stateDbPath, scratch);
    const schema = stateDb.checkSchema();
    if (!schema.ok) {
      throw new Error(
        `Unsupported Cursor storage schema: ${schema.errors.join("; ")}`,
      );
    }

    const source = resolveHistorySource({
      stateDb,
      discovered,
      exact,
      currentPath: current.path,
      log,
    });

    if (!source) {
      throw new Error(
        `No Cursor chat history found for this folder.\nOpen the folder in Cursor and start a chat, then Refresh Index.`,
      );
    }

    if (source.previousPath) {
      previousLocation = source.previousPath;
      warnings.push(
        `Using history from previous location: ${source.previousPath}`,
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

    if (exact && exact.kind === "folder") {
      options.store.upsertWorkspace({
        cursorWorkspaceId: exact.cursorWorkspaceId,
        folderUri: exact.folderUri,
        path: exact.path,
        projectId: project.id,
      });
    }

    const workspace = options.store.upsertWorkspace({
      cursorWorkspaceId: source.cursorWorkspaceId,
      folderUri: source.folderUri,
      path: source.path ?? current.path,
      projectId: project.id,
    });
    workspaceId = workspace.id;

    const summaries = listChatsForWorkspace(stateDb, source.cursorWorkspaceId);
    log(
      `Found ${summaries.length} chat(s) with content in workspace ${source.cursorWorkspaceId}`,
    );

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
        messageCount += messages.length;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "unknown chat parse error";
        warnings.push(`Skipped chat ${summary.cursorChatId}: ${msg}`);
        log(warnings[warnings.length - 1]!);
      }
    }

    options.store.upsertWorkspace({
      cursorWorkspaceId: source.cursorWorkspaceId,
      chatCountMeta: chatCount,
      projectId: project.id,
      path: source.path ?? current.path,
      folderUri: source.folderUri,
    });
    options.store.markDeepIndexed(workspace.id);
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
  };
}

function resolveHistorySource(input: {
  stateDb: CursorStateDb;
  discovered: DiscoveredWorkspace[];
  exact: DiscoveredWorkspace | undefined;
  currentPath: string;
  log: (msg: string) => void;
}):
  | {
      cursorWorkspaceId: string;
      folderUri?: string;
      path?: string;
      previousPath?: string;
    }
  | undefined {
  const exactCount =
    input.exact && input.exact.kind === "folder"
      ? countChatsWithContent(input.stateDb, input.exact.cursorWorkspaceId)
      : 0;

  if (input.exact && input.exact.kind === "folder" && exactCount > 0) {
    input.log(
      `Using exact workspace match ${input.exact.cursorWorkspaceId} (${exactCount} chats)`,
    );
    return {
      cursorWorkspaceId: input.exact.cursorWorkspaceId,
      folderUri: input.exact.folderUri,
      path: input.exact.path,
    };
  }

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
        score: number;
      }
    | undefined;

  for (const candidate of candidates) {
    const count = countChatsWithContent(
      input.stateDb,
      candidate.cursorWorkspaceId,
    );
    if (count === 0) {
      continue;
    }
    const oldPathGone = candidate.path ? !existsSync(candidate.path) : false;
    const score = count + (oldPathGone ? 1_000_000 : 0);
    if (!best || score > best.score) {
      best = { workspace: candidate, count, score };
    }
  }

  if (best) {
    input.log(
      `Exact path has ${exactCount} chats; falling back to ${best.workspace.path} (${best.count} chats)`,
    );
    return {
      cursorWorkspaceId: best.workspace.cursorWorkspaceId,
      folderUri: best.workspace.folderUri,
      path: best.workspace.path,
      previousPath: best.workspace.path,
    };
  }

  if (input.exact && input.exact.kind === "folder") {
    return {
      cursorWorkspaceId: input.exact.cursorWorkspaceId,
      folderUri: input.exact.folderUri,
      path: input.exact.path,
    };
  }

  return undefined;
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
