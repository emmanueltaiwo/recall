import { join } from "node:path";

export interface ResolveCursorUserDataDirOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export function resolveCursorUserDataDir(
  options: ResolveCursorUserDataDirOptions,
): string {
  const override = options.env.RECALL_CURSOR_USER_DATA_DIR;
  if (override && override.length > 0) {
    return override;
  }

  if (options.platform !== "darwin") {
    throw new Error(
      `Recall currently supports macOS Cursor paths only (got platform "${options.platform}")`,
    );
  }

  return join(
    options.homeDir,
    "Library",
    "Application Support",
    "Cursor",
    "User",
  );
}

export function resolveWorkspaceStorageDir(userDataDir: string): string {
  return join(userDataDir, "workspaceStorage");
}

export function resolveGlobalStateDb(userDataDir: string): string {
  return join(userDataDir, "globalStorage", "state.vscdb");
}
