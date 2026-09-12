import * as vscode from "vscode";
import { realpathSync } from "node:fs";

export type CurrentWorkspaceResult =
  | {
      ok: true;
      folder: vscode.WorkspaceFolder;
      path: string;
    }
  | {
      ok: false;
      reason: "no-folder" | "multi-root";
      message: string;
    };

export function detectCurrentWorkspace(
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined = vscode
    .workspace.workspaceFolders,
): CurrentWorkspaceResult {
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return {
      ok: false,
      reason: "no-folder",
      message: "Open a single project folder to use Recall.",
    };
  }

  if (workspaceFolders.length > 1) {
    return {
      ok: false,
      reason: "multi-root",
      message:
        "Recall supports one folder at a time. Open a single-folder workspace.",
    };
  }

  const folder = workspaceFolders[0]!;
  let path = folder.uri.fsPath;
  try {
    path = realpathSync(path);
  } catch {
    /* keep fsPath */
  }

  return { ok: true, folder, path };
}
