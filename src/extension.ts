import * as vscode from "vscode";
import {
  EXPORT_SOFT_CHAR_LIMIT,
  exportChatToProject,
  formatChatMarkdown,
} from "./export/exportChat";
import { indexCurrentWorkspace } from "./indexing/indexCurrentWorkspace";
import { restoreChatsIntoCursor } from "./indexing/restoreIntoCursor";
import { RecallStore, recallDbPath } from "./store/recallStore";
import type { Chat } from "./domain/types";
import { openChatDocument } from "./ui/chatViewer";
import { ChatItem, isChatItem, RecallTreeProvider } from "./ui/treeProvider";
import { detectCurrentWorkspace } from "./workspace/currentWorkspace";

let store: RecallStore | undefined;
let output: vscode.OutputChannel | undefined;
let indexing = false;
let currentCursorWorkspaceId: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Recall");
  context.subscriptions.push(output);

  store = new RecallStore(recallDbPath(context.globalStorageUri.fsPath));

  const tree = new RecallTreeProvider(() => store);
  const treeView = vscode.window.createTreeView("recall.chats", {
    treeDataProvider: tree,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  statusBar.command = "recall.refreshIndex";
  context.subscriptions.push(statusBar);

  const resolveChat = (chatIdOrItem?: string | ChatItem): Chat | undefined => {
    if (!store) {
      return undefined;
    }
    if (isChatItem(chatIdOrItem)) {
      return chatIdOrItem.chat;
    }
    if (typeof chatIdOrItem === "string") {
      return store.getChat(chatIdOrItem);
    }
    return undefined;
  };

  const setBusy = (busy: boolean, detail?: string) => {
    indexing = busy;
    if (busy) {
      tree.setStatus({ kind: "indexing", detail });
      statusBar.text = "$(loading~spin) Recall: indexing…";
      statusBar.show();
      treeView.message = detail ?? "Indexing Cursor chats…";
    } else {
      statusBar.hide();
      treeView.message = undefined;
    }
  };

  const exportChat = async (
    chat: Chat,
    opts?: { copy?: boolean; reveal?: boolean },
  ) => {
    if (!store) {
      return undefined;
    }
    const current = detectCurrentWorkspace();
    if (!current.ok) {
      void vscode.window.showErrorMessage(current.message);
      return undefined;
    }
    const messages = store.getMessages(chat.id);
    if (messages.length === 0) {
      void vscode.window.showWarningMessage(
        "This chat has no messages to export.",
      );
      return undefined;
    }
    if (chat.characterCount > EXPORT_SOFT_CHAR_LIMIT) {
      const proceed = await vscode.window.showWarningMessage(
        `This chat is large (~${Math.round(chat.characterCount / 1000)}k characters). Continue?`,
        "Continue",
        "Cancel",
      );
      if (proceed !== "Continue") {
        return undefined;
      }
    }
    const project = chat.projectId
      ? store.getProject(chat.projectId)
      : undefined;
    const workspace = store.getWorkspace(chat.workspaceId);
    const filePath = exportChatToProject({
      workspaceRoot: current.path,
      projectName: project?.name ?? "project",
      chat,
      messages,
      cursorWorkspaceId: workspace?.cursorWorkspaceId,
    });
    if (opts?.copy !== false) {
      await vscode.env.clipboard.writeText(
        formatChatMarkdown({
          projectName: project?.name ?? "project",
          chat,
          messages,
          cursorWorkspaceId: workspace?.cursorWorkspaceId,
        }),
      );
    }
    if (opts?.reveal) {
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    return filePath;
  };

  const refresh = async (opts?: { silent?: boolean }) => {
    if (!store || indexing) {
      return;
    }
    const current = detectCurrentWorkspace();
    if (!current.ok) {
      tree.setProjectId(undefined);
      tree.setStatus({ kind: "unsupported", message: current.message });
      return;
    }

    setBusy(true, "Finding Cursor chats for this project…");
    try {
      const result = await indexCurrentWorkspace({
        store,
        globalStoragePath: context.globalStorageUri.fsPath,
        output,
      });
      tree.setProjectId(result.projectId);
      currentCursorWorkspaceId = result.currentCursorWorkspaceId;
      tree.setCurrentCursorWorkspaceId(result.currentCursorWorkspaceId);
      tree.setStatus({ kind: "ready" });
      treeView.description =
        result.chatCount > 0 ? `${result.chatCount} chats` : undefined;

      if (result.previousLocation && result.previousChatCount > 0) {
        const unrestored = store
          .listChatsForProject(result.projectId)
          .filter((chat) => chatNeedsRestore(chat));
        const action = await vscode.window.showInformationMessage(
          `Found ${result.previousChatCount} chat(s) from a previous folder location. Restore them into this project's Cursor history?`,
          "Restore into Cursor",
          "Not now",
        );
        if (action === "Restore into Cursor" && store) {
          await runRestore(
            unrestored.length > 0
              ? unrestored
              : store.listChatsForProject(result.projectId),
          );
        }
      } else if (result.repairedChatCount > 0) {
        void vscode.window.showInformationMessage(
          `Repaired ${result.repairedChatCount} restored chat(s). Quit Cursor (Cmd+Q) and reopen this project to see full assistant replies.`,
        );
      } else if (!opts?.silent) {
        void vscode.window.showInformationMessage(
          result.chatCount > 0
            ? `Loaded ${result.chatCount} chat(s).`
            : "No chats found for this folder.",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output?.appendLine(`Index failed: ${message}`);
      tree.setStatus({ kind: "error", message });
      if (!opts?.silent) {
        void vscode.window.showErrorMessage(`Recall: ${message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const runRestore = async (chats: Chat[]) => {
    if (!store) {
      return;
    }
    const usable = chats.filter((c) => c.messageCount > 0);
    if (usable.length === 0) {
      void vscode.window.showWarningMessage(
        "No chats with messages to restore.",
      );
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Restore ${usable.length} chat(s) into this folder's Cursor history?\n\nA backup is created first. Afterward, quit Cursor completely (Cmd+Q) and reopen this project.`,
      { modal: true },
      "Restore",
      "Cancel",
    );
    if (confirm !== "Restore") {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Recall: restoring chats into Cursor…",
        },
        async () => {
          const result = await restoreChatsIntoCursor({
            store: store!,
            globalStoragePath: context.globalStorageUri.fsPath,
            chats: usable,
            output,
          });
          const after = await vscode.window.showInformationMessage(
            `Restored ${result.restoredCount} chat(s). Quit Cursor (Cmd+Q) and reopen this project to see them.`,
            "Copy Backup Path",
          );
          if (after === "Copy Backup Path") {
            await vscode.env.clipboard.writeText(result.backupDir);
          }
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output?.appendLine(`Restore failed: ${message}`);
      if (/database is locked|using its database/i.test(message)) {
        void vscode.window
          .showWarningMessage(
            "Cursor has its database locked. Close other Cursor windows, wait a moment, then try Restore again.",
            "Retry Restore",
          )
          .then((choice) => {
            if (choice === "Retry Restore") {
              void runRestore(usable);
            }
          });
      } else {
        void vscode.window.showErrorMessage(`Restore failed: ${message}`);
      }
    }
  };

  const chatNeedsRestore = (chat: Chat): boolean => {
    if (!store || !currentCursorWorkspaceId) {
      return false;
    }
    const workspace = store.getWorkspace(chat.workspaceId);
    return Boolean(
      workspace?.cursorWorkspaceId &&
      workspace.cursorWorkspaceId !== currentCursorWorkspaceId,
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("recall.refreshIndex", () =>
      refresh({ silent: false }),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recall.openChat",
      async (chatIdOrItem?: string | ChatItem) => {
        const chat = resolveChat(chatIdOrItem);
        if (!chat || !store) {
          void vscode.window.showErrorMessage("Chat not found.");
          return;
        }
        await openChatDocument(chat, store.getMessages(chat.id));

        if (chatNeedsRestore(chat)) {
          const next = await vscode.window.showInformationMessage(
            "This chat still belongs to a previous folder location.",
            "Restore into Cursor",
            "Export for @Files",
          );
          if (next === "Restore into Cursor") {
            await runRestore([chat]);
          } else if (next === "Export for @Files") {
            const filePath = await exportChat(chat, { reveal: true });
            if (filePath) {
              void vscode.window.showInformationMessage(
                `Exported and copied. In Agent, use @Files → ${vscode.workspace.asRelativePath(filePath, false)}`,
              );
            }
          }
          return;
        }

        const next = await vscode.window.showInformationMessage(
          chat.title,
          "Export for @Files",
        );
        if (next === "Export for @Files") {
          const filePath = await exportChat(chat, { reveal: true });
          if (filePath) {
            void vscode.window.showInformationMessage(
              `Exported and copied. In Agent, use @Files → ${vscode.workspace.asRelativePath(filePath, false)}`,
            );
          }
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recall.useInCursor",
      async (item?: ChatItem) => {
        const chat = resolveChat(item);
        if (!chat) {
          void vscode.window.showErrorMessage("Select a chat first.");
          return;
        }
        const filePath = await exportChat(chat, { reveal: false });
        if (!filePath) {
          return;
        }
        const relative = vscode.workspace.asRelativePath(filePath, false);
        const choice = await vscode.window.showInformationMessage(
          `Exported ${relative} and copied to clipboard. In Agent: @Files → pick the file, or paste.`,
          "Open File",
          "Reveal",
        );
        if (choice === "Open File") {
          const doc = await vscode.workspace.openTextDocument(filePath);
          await vscode.window.showTextDocument(doc, { preview: true });
        } else if (choice === "Reveal") {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(filePath),
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recall.restoreIntoCursor",
      async (item?: ChatItem) => {
        if (!store) {
          return;
        }
        const selected = resolveChat(item);
        if (!selected) {
          void vscode.window.showErrorMessage("Select a chat to restore.");
          return;
        }
        if (!chatNeedsRestore(selected)) {
          void vscode.window.showInformationMessage(
            "This chat already belongs to the current folder in Cursor.",
          );
          return;
        }

        const scope = await vscode.window.showQuickPick(
          [
            {
              label: "This chat only",
              description: selected.title,
              value: "one" as const,
            },
            {
              label: "All chats in this project",
              description: `${store.listChatsForProject(selected.projectId ?? "").length} chats`,
              value: "all" as const,
            },
          ],
          { title: "Restore into Cursor history", placeHolder: "Choose scope" },
        );
        if (!scope) {
          return;
        }

        const chats =
          scope.value === "one"
            ? [selected]
            : selected.projectId
              ? store.listChatsForProject(selected.projectId)
              : [selected];
        await runRestore(chats);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recall.exportChat",
      async (item?: ChatItem) => {
        const chat = resolveChat(item);
        if (!chat) {
          void vscode.window.showErrorMessage("Select a chat to export.");
          return;
        }
        const filePath = await exportChat(chat, { copy: false, reveal: true });
        if (filePath) {
          void vscode.window.showInformationMessage(
            `Exported to ${vscode.workspace.asRelativePath(filePath, false)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recall.copyChat",
      async (item?: ChatItem) => {
        const chat = resolveChat(item);
        if (!chat || !store) {
          void vscode.window.showErrorMessage("Select a chat to copy.");
          return;
        }
        const messages = store.getMessages(chat.id);
        const project = chat.projectId
          ? store.getProject(chat.projectId)
          : undefined;
        await vscode.env.clipboard.writeText(
          formatChatMarkdown({
            projectName: project?.name ?? "project",
            chat,
            messages,
          }),
        );
        void vscode.window.showInformationMessage("Chat copied to clipboard.");
      },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refresh({ silent: true });
    }),
  );

  void refresh({ silent: true });
}

export function deactivate(): void {
  store?.close();
  store = undefined;
}
