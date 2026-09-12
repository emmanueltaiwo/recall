export type DiscoveredWorkspaceKind =
  | "folder"
  | "multiRoot"
  | "empty"
  | "unknown";

export interface DiscoveredWorkspace {
  cursorWorkspaceId: string;
  kind: DiscoveredWorkspaceKind;
  folderUri?: string;
  path?: string;
  issue?: string;
}

export interface CursorChatSummary {
  cursorChatId: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  isArchived: boolean;
  isSubagent: boolean;
  unifiedMode?: string;
  messageCountEstimate?: number;
}

export interface CursorChatMessage {
  cursorMessageId: string;
  role: "user" | "assistant" | "system" | "other";
  content: string;
  createdAt?: number;
}

export interface CursorSchemaSupport {
  ok: boolean;
  parserVersion: string;
  errors: string[];
}
