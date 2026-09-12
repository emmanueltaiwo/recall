import * as vscode from "vscode";
import type { Chat } from "../domain/types";
import type { RecallStore } from "../store/recallStore";

export type TreeStatus =
  | { kind: "idle" }
  | { kind: "indexing"; detail?: string }
  | { kind: "ready" }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string };

export type RecallTreeItem = ChatItem | StatusItem;

export class ChatItem extends vscode.TreeItem {
  constructor(
    readonly chat: Chat,
    opts?: { needsRestore?: boolean },
  ) {
    super(chat.title || "Untitled chat", vscode.TreeItemCollapsibleState.None);
    this.contextValue = opts?.needsRestore ? "chatNeedsRestore" : "chat";
    this.description = formatChatMeta(chat);
    this.tooltip = new vscode.MarkdownString(
      `**${escapeMd(chat.title)}**\n\n${chat.messageCount} messages · ${formatChars(chat.characterCount)}`,
    );
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
    this.command = {
      command: "recall.openChat",
      title: "Open Chat",
      arguments: [chat.id],
    };
  }
}

class StatusItem extends vscode.TreeItem {
  constructor(label: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "status";
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
  }
}

export class RecallTreeProvider implements vscode.TreeDataProvider<RecallTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    RecallTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projectId: string | undefined;
  private status: TreeStatus = { kind: "idle" };
  private currentCursorWorkspaceId: string | undefined;

  constructor(private readonly getStore: () => RecallStore | undefined) {}

  setStatus(status: TreeStatus): void {
    this.status = status;
    this.refresh();
  }

  setCurrentCursorWorkspaceId(id: string | undefined): void {
    this.currentCursorWorkspaceId = id;
    this.refresh();
  }

  setProjectId(projectId: string | undefined): void {
    this.projectId = projectId;
    if (projectId) {
      this.status = { kind: "ready" };
    }
    this.refresh();
  }

  getProjectId(): string | undefined {
    return this.projectId;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RecallTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RecallTreeItem): RecallTreeItem[] {
    if (element) {
      return [];
    }

    if (this.status.kind === "indexing") {
      return [
        new StatusItem(
          this.status.detail ?? "Indexing Cursor chats…",
          "loading~spin",
        ),
      ];
    }

    if (this.status.kind === "unsupported") {
      return [new StatusItem(this.status.message, "info")];
    }

    if (this.status.kind === "error") {
      return [new StatusItem(this.status.message, "error")];
    }

    const store = this.getStore();
    if (!store) {
      return [new StatusItem("Starting Recall…", "loading~spin")];
    }

    if (!this.projectId) {
      return [
        new StatusItem(
          "Open a project folder, then refresh to load chats.",
          "folder-opened",
        ),
      ];
    }

    const chats = store
      .listChatsForProject(this.projectId)
      .filter((c) => !c.isArchived);

    if (chats.length === 0) {
      return [
        new StatusItem(
          "No chats found for this folder yet.",
          "comment-discussion",
        ),
      ];
    }

    return chats.map((c) => {
      const workspace = store.getWorkspace(c.workspaceId);
      const needsRestore = Boolean(
        this.currentCursorWorkspaceId &&
        workspace?.cursorWorkspaceId &&
        workspace.cursorWorkspaceId !== this.currentCursorWorkspaceId,
      );
      return new ChatItem(c, { needsRestore });
    });
  }
}

export function isChatItem(item: unknown): item is ChatItem {
  return item instanceof ChatItem;
}

function formatChatMeta(chat: Chat): string {
  const when = chat.updatedAt ?? chat.createdAt;
  const time = when ? relativeTime(when) : undefined;
  const parts = [`${chat.messageCount} msgs`];
  if (time) {
    parts.push(time);
  }
  return parts.join(" · ");
}

function formatChars(n: number): string {
  if (n < 1000) {
    return `${n} chars`;
  }
  if (n < 10_000) {
    return `${(n / 1000).toFixed(1)}k chars`;
  }
  return `${Math.round(n / 1000)}k chars`;
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) {
    return "just now";
  }
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}
