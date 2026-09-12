export interface Project {
  id: string;
  name: string;
  gitRemote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Workspace {
  id: string;
  cursorWorkspaceId: string;
  folderUri?: string;
  path?: string;
  projectId?: string;
  lastDiscoveredAt: number;
  deepIndexedAt?: number;
  chatCountMeta?: number;
}

export interface Chat {
  id: string;
  projectId?: string;
  workspaceId: string;
  cursorChatId: string;
  title: string;
  isArchived: boolean;
  messageCount: number;
  characterCount: number;
  createdAt?: number;
  updatedAt?: number;
  contentHash?: string;
}

export interface Message {
  id: string;
  chatId: string;
  cursorMessageId: string;
  role: "user" | "assistant" | "system" | "other";
  content: string;
  sequence: number;
  createdAt?: number;
}

export type MessageRole = Message["role"];
