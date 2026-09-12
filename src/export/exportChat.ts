import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Chat, Message } from "../domain/types";

export function formatChatMarkdown(input: {
  projectName: string;
  chat: Chat;
  messages: Message[];
  cursorWorkspaceId?: string;
}): string {
  const range =
    input.messages.length === 0
      ? "none"
      : `1-${input.messages.length}`;

  const frontmatter = [
    "---",
    `recall_export_version: 1`,
    `project: ${JSON.stringify(input.projectName)}`,
    `title: ${JSON.stringify(input.chat.title)}`,
    `source: cursor`,
    input.cursorWorkspaceId
      ? `cursor_workspace_id: ${JSON.stringify(input.cursorWorkspaceId)}`
      : undefined,
    `cursor_chat_id: ${JSON.stringify(input.chat.cursorChatId)}`,
    `message_range: ${JSON.stringify(range)}`,
    input.chat.createdAt
      ? `created_at: ${JSON.stringify(new Date(input.chat.createdAt).toISOString())}`
      : undefined,
    input.chat.updatedAt
      ? `updated_at: ${JSON.stringify(new Date(input.chat.updatedAt).toISOString())}`
      : undefined,
    `exported_at: ${JSON.stringify(new Date().toISOString())}`,
    `character_count: ${input.chat.characterCount}`,
    "---",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const body = input.messages
    .map((m) => {
      const heading =
        m.role === "user"
          ? "### User"
          : m.role === "assistant"
            ? "### Assistant"
            : m.role === "system"
              ? "### System"
              : "### Other";
      return `${heading}\n\n${m.content}\n`;
    })
    .join("\n");

  return `${frontmatter}${body}`;
}

export function exportChatToProject(input: {
  workspaceRoot: string;
  projectName: string;
  chat: Chat;
  messages: Message[];
  cursorWorkspaceId?: string;
}): string {
  const exportsDir = join(input.workspaceRoot, ".recall", "exports");
  mkdirSync(exportsDir, { recursive: true });
  ensureGitignore(input.workspaceRoot);

  const slug = slugify(input.chat.title).slice(0, 40) || "chat";
  const shortId = input.chat.cursorChatId.slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(exportsDir, `${slug}-${shortId}-${stamp}.md`);

  const markdown = formatChatMarkdown(input);
  writeFileSync(filePath, markdown, "utf8");
  return filePath;
}

function ensureGitignore(workspaceRoot: string): void {
  const gi = join(workspaceRoot, ".gitignore");
  const entry = ".recall/";
  if (!existsSync(gi)) {
    writeFileSync(gi, `${entry}\n`, "utf8");
    return;
  }
  const current = readFileSync(gi, "utf8");
  if (current.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === ".recall")) {
    return;
  }
  const suffix = current.endsWith("\n") ? "" : "\n";
  writeFileSync(gi, `${current}${suffix}${entry}\n`, "utf8");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const EXPORT_SOFT_CHAR_LIMIT = 200_000;
