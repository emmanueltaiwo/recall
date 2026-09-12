export type {
  CursorChatMessage,
  CursorChatSummary,
  CursorSchemaSupport,
  DiscoveredWorkspace,
  DiscoveredWorkspaceKind,
} from "./types";
export {
  discoverWorkspaces,
  type DiscoverWorkspacesOptions,
} from "./discoverWorkspaces";
export {
  resolveCursorUserDataDir,
  resolveGlobalStateDb,
  resolveWorkspaceStorageDir,
  type ResolveCursorUserDataDirOptions,
} from "./paths";
export { CursorStateDb, PARSER_VERSION, ensureScratchDir } from "./stateDb";
export {
  listChatsForWorkspace,
  getChatMessages,
  countChatsWithContent,
} from "./chats";
export {
  restoreComposersToWorkspace,
  repairComposerDataWorkspaces,
  listRecentBackups,
  type RestoreResult,
  type RestoreTargetWorkspace,
} from "./restore";
