# Recall

Local-first utility that keeps Cursor conversation history associated with projects and makes that history browsable, searchable, and referenceable. It is not an AI assistant, memory agent, or cloud service.

## Language

**Project**:
Recall's durable identity for a developer's codebase across path changes and workspace recreation.
_Avoid_: Workspace (when meaning Recall's durable identity), repository alone

**Workspace**:
Cursor's workspace identity for an open folder, typically derived from path and filesystem metadata, with a stored folder URI.
_Avoid_: Project (when meaning Cursor's id), folder (when meaning the identity record)

**Relink**:
User-confirmed association of one or more Cursor Workspaces (and their chats) with a Recall Project in Recall's own index, without modifying Cursor's storage.
_Avoid_: Restore, import, migrate (for this safe default)

**Restore**:
Experimental, explicit operation that rewrites Cursor's internal indexes so chats appear in Cursor's native history for a Workspace.
_Avoid_: Relink, using "restore" for Recall-side-only association

**Export**:
Writing a selected chat or message range to a file the user can open or `@Files` in Cursor.

**Copy**:
Placing a selected chat or message range on the clipboard.

**Reference**:
Umbrella for getting historical chat content into the current workflow via Export, Copy, and any later MCP or native mechanisms.
_Avoid_: Attach (when meaning Export or Copy)

**Attach**:
Future native Agent context-chip attachment of a historical chat into the current Cursor Agent conversation. Technically blocked on current Cursor extension APIs.
_Avoid_: Using Attach for MVP Export or Copy

**Relink Candidate**:
A previously known Workspace that Recall believes may belong to the current Project, offered for user confirmation and never applied automatically.

**Chat**:
A top-level, user-facing Cursor conversation Recall indexes for browse, search, preview, Export, and Copy.
_Avoid_: Subagent, ephemeral or internal Cursor artifacts (excluded from the default corpus)

**Discovery**:
Lightweight global scan of Cursor Workspaces (identity, paths, counts, timestamps, git remote when available) used for Relink matching without body-indexing everything.

**Deep Index**:
Full message-body indexing into Recall's search store, performed when a Workspace is linked or browsed, or when the user opts into indexing all history.

**Snapshot**:
A consistent copy of Cursor storage files used for bulk read/indexing so Recall does not hold long transactions on Cursor's live database.

## Settled decisions

These are product/domain locks from the design grill (Q1–Q20). Architecture detail lives in `docs/`; irreversible choices are also in `docs/adr/`.

1. **Wedge** — Primary: recover history after a project is moved or renamed. Secondary: cross-project browse/search. Not a better `@Chats`.
2. **MVP scope** — Relink + Discovery/Deep Index + browse/search/preview + Export/Copy. Native Attach is not required. Native Restore is not a launch requirement.
3. **Relink vs Restore** — Relink is the safe default for browsing in Recall. Restore remaps chats into Cursor history for the current folder (backup first; quit/reopen Cursor). See ADR 0001.
4. **Reference without Attach** — MVP Reference is Export (Markdown for `@Files`) and Copy. Do not market these as native Agent chips. MCP is optional later. Attach stays long-term if Cursor exposes an API.
5. **Dual identity** — Model Project and Workspace separately. See ADR 0002.
6. **Confirm-only Relink** — Strong suggestion when git remote + basename match and the old path is gone. Never auto-Relink. Same remote never merges live clones.
7. **Relink success** — Chats appear under the Recall Project; search, preview, Export, and Copy work; UI opens recovered chats in Recall. Cursor's native sidebar may stay empty; say so explicitly.
8. **Exports** — Default to `.recall/exports/` (gitignored); Save As allowed; human-readable Markdown with frontmatter; size threshold forces range or split; no AI summary; treat as sensitive.
9. **Detection UX** — On activate/open, one-time strong-candidate banner; always list candidates in the sidebar; dismissible; no timer nag. Command: `Recall: Relink Project History`.
10. **Indexing** — Snapshots for bulk work; short read-only live queries only when appropriate; incremental after first scan; usable if Cursor is temporarily unavailable; never require quit for normal use. See ADR 0003.
11. **Corpus** — Top-level user-facing chats; archived indexed but collapsed by default; exclude subagents/ephemeral from the default corpus.
12. **Native Restore kill bar** — Do not ship if unsafe, irreversible, or not version-tolerant; one conversation surface only is a serious limitation. Core product must work without Restore.
13. **Workspace types** — MVP is single-folder only. Multi-root and no-folder: explain and skip Relink identity inference; browse already-indexed chats if possible.
14. **Project birth** — Auto-create a Project for every opened single-folder workspace. Empty history is valid. Strong existing match → Relink Candidate, not silent merge/duplicate.
15. **Orphans** — Global Discovery metadata always; Deep Index on link, browse, or “Index all history.”
16. **Schema break** — Stop indexing affected data; keep last-known-good index; diagnostics without message contents unless the user opts in.
