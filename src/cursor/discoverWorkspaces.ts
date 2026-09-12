import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoveredWorkspace } from "./types";

export interface DiscoverWorkspacesOptions {
  workspaceStorageDir: string;
}

export async function discoverWorkspaces(
  options: DiscoverWorkspacesOptions,
): Promise<DiscoveredWorkspace[]> {
  const entries = await readdir(options.workspaceStorageDir, {
    withFileTypes: true,
  });

  const results: DiscoveredWorkspace[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const cursorWorkspaceId = entry.name;
    const workspaceJsonPath = join(
      options.workspaceStorageDir,
      cursorWorkspaceId,
      "workspace.json",
    );

    let raw: string;
    try {
      raw = await readFile(workspaceJsonPath, "utf8");
    } catch {
      results.push({
        cursorWorkspaceId,
        kind: "empty",
        issue: "missing workspace.json",
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      results.push({
        cursorWorkspaceId,
        kind: "unknown",
        issue: "malformed workspace.json",
      });
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      results.push({
        cursorWorkspaceId,
        kind: "unknown",
        issue: "workspace.json is not an object",
      });
      continue;
    }

    const record = parsed as Record<string, unknown>;

    if (typeof record.folder === "string") {
      results.push(fromFolderUri(cursorWorkspaceId, record.folder));
      continue;
    }

    if (typeof record.workspace === "string") {
      results.push({
        cursorWorkspaceId,
        kind: "multiRoot",
        folderUri: record.workspace,
        issue: "multi-root workspace file; no single folder path",
      });
      continue;
    }

    results.push({
      cursorWorkspaceId,
      kind: "unknown",
      issue: "workspace.json missing folder and workspace keys",
    });
  }

  return results.sort((a, b) =>
    a.cursorWorkspaceId.localeCompare(b.cursorWorkspaceId),
  );
}

function fromFolderUri(
  cursorWorkspaceId: string,
  folderUri: string,
): DiscoveredWorkspace {
  const path = fileUriToPath(folderUri);
  const base: DiscoveredWorkspace = {
    cursorWorkspaceId,
    kind: "folder",
    folderUri,
  };

  if (path === undefined) {
    return {
      ...base,
      issue: "folder URI is not a convertible file: path",
    };
  }

  return { ...base, path };
}

function fileUriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") {
      return undefined;
    }
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}
