import * as vscode from "vscode";
import type { Chat, Message } from "../domain/types";

export function openChatDocument(
  chat: Chat,
  messages: Message[],
): Thenable<vscode.TextEditor> {
  const body = messages
    .map((m) => {
      const label = m.role.toUpperCase();
      return `## ${label}\n\n${m.content}`;
    })
    .join("\n\n---\n\n");

  const header = `# ${chat.title}\n\n_${chat.messageCount} messages · ${chat.characterCount} characters_\n\n---\n\n`;
  const content = header + (body || "_No messages parsed for this chat._");

  return vscode.workspace
    .openTextDocument({
      content,
      language: "markdown",
    })
    .then((doc) => vscode.window.showTextDocument(doc, { preview: true }));
}
