import type { CursorChatMessage, CursorChatSummary } from "./types";
import type { CursorStateDb } from "./stateDb";

interface HeaderRow {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: number | null;
  isSubagent: number | null;
  value: string | null;
}

export function listChatsForWorkspace(
  stateDb: CursorStateDb,
  cursorWorkspaceId: string,
): CursorChatSummary[] {
  const rows = stateDb.db
    .prepare(
      `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value
       FROM composerHeaders
       WHERE workspaceId = ?
       ORDER BY COALESCE(lastUpdatedAt, createdAt, 0) DESC`,
    )
    .all(cursorWorkspaceId) as unknown as HeaderRow[];

  const chats: CursorChatSummary[] = [];

  for (const row of rows) {
    if (row.isSubagent === 1) {
      continue;
    }

    let title = "Untitled chat";
    let unifiedMode: string | undefined;
    let messageCountEstimate: number | undefined;

    if (row.value) {
      try {
        const value = JSON.parse(row.value) as Record<string, unknown>;
        if (typeof value.name === "string" && value.name.trim()) {
          title = value.name.trim();
        } else if (
          typeof value.subtitle === "string" &&
          value.subtitle.trim()
        ) {
          title = value.subtitle.trim();
        }
        if (typeof value.unifiedMode === "string") {
          unifiedMode = value.unifiedMode;
        }
      } catch {
        /* keep defaults */
      }
    }

    const composerData = readComposerData(stateDb, row.composerId);
    if (composerData) {
      if (title === "Untitled chat" && typeof composerData.name === "string") {
        const name = composerData.name.trim();
        if (name) {
          title = name;
        }
      }
      const headers = composerData.fullConversationHeadersOnly;
      if (Array.isArray(headers)) {
        messageCountEstimate = headers.length;
        if (title === "Untitled chat") {
          const preview = firstUserPreview(headers);
          if (preview) {
            title = truncate(preview, 80);
          }
        }
      }
    }

    if (!messageCountEstimate || messageCountEstimate < 1) {
      continue;
    }

    chats.push({
      cursorChatId: row.composerId,
      title,
      createdAt: row.createdAt ?? undefined,
      updatedAt: row.lastUpdatedAt ?? undefined,
      isArchived: row.isArchived === 1,
      isSubagent: false,
      unifiedMode,
      messageCountEstimate,
    });
  }

  return chats;
}

export function getChatMessages(
  stateDb: CursorStateDb,
  cursorChatId: string,
): CursorChatMessage[] {
  const composerData = readComposerData(stateDb, cursorChatId);
  const headers = composerData?.fullConversationHeadersOnly;

  const bubbleIds: string[] = [];
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (
        header &&
        typeof header === "object" &&
        typeof (header as { bubbleId?: unknown }).bubbleId === "string"
      ) {
        bubbleIds.push((header as { bubbleId: string }).bubbleId);
      }
    }
  }

  if (bubbleIds.length === 0) {
    return [];
  }

  const getBubble = stateDb.db.prepare(
    `SELECT value FROM cursorDiskKV WHERE key = ?`,
  );

  const messages: CursorChatMessage[] = [];

  for (const bubbleId of bubbleIds) {
    const row = getBubble.get(
      `bubbleId:${cursorChatId}:${bubbleId}`,
    ) as unknown as { value: string } | undefined;
    if (!row?.value) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      continue;
    }

    const role = mapBubbleRole(parsed.type);
    const content = extractBubbleText(parsed);
    if (!content.trim()) {
      continue;
    }

    let createdAt: number | undefined;
    if (typeof parsed.createdAt === "string") {
      const ms = Date.parse(parsed.createdAt);
      if (!Number.isNaN(ms)) {
        createdAt = ms;
      }
    } else if (typeof parsed.startedAtMs === "number") {
      createdAt = parsed.startedAtMs;
    }

    messages.push({
      cursorMessageId: bubbleId,
      role,
      content,
      createdAt,
    });
  }

  return messages;
}

export function countChatsWithContent(
  stateDb: CursorStateDb,
  cursorWorkspaceId: string,
): number {
  return listChatsForWorkspace(stateDb, cursorWorkspaceId).length;
}

function readComposerData(
  stateDb: CursorStateDb,
  composerId: string,
): Record<string, unknown> | undefined {
  const row = stateDb.db
    .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(`composerData:${composerId}`) as unknown as
    | { value: string }
    | undefined;
  if (!row?.value) {
    return undefined;
  }
  try {
    return JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function firstUserPreview(headers: unknown[]): string | undefined {
  for (const header of headers) {
    if (!header || typeof header !== "object") {
      continue;
    }
    const h = header as {
      type?: unknown;
      grouping?: { textPreview?: unknown };
    };
    if (h.type === 1 && typeof h.grouping?.textPreview === "string") {
      const preview = h.grouping.textPreview.trim();
      if (preview) {
        return preview;
      }
    }
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function mapBubbleRole(
  type: unknown,
): "user" | "assistant" | "system" | "other" {
  if (type === 1) {
    return "user";
  }
  if (type === 2) {
    return "assistant";
  }
  if (type === 3) {
    return "system";
  }
  return "other";
}

function extractBubbleText(bubble: Record<string, unknown>): string {
  if (typeof bubble.text === "string" && bubble.text.trim()) {
    return bubble.text;
  }
  if (Array.isArray(bubble.toolResults) && bubble.toolResults.length > 0) {
    return `[${bubble.toolResults.length} tool result(s)]`;
  }
  return "";
}
