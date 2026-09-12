# Recall

Local-first Cursor extension that keeps conversation history connected when you move or rename a project.

## Features

- **Browse** Cursor chats for the current folder (including history from a previous path)
- **Restore** chats into Cursor history for the new folder location
- **Export** chats as Markdown for `@Files`, or **copy** to the clipboard
- Works entirely on your machine — no account, cloud, or AI backend

## Requirements

- macOS
- Cursor (or VS Code-compatible host)
- A **single-folder** workspace

## Usage

1. Install the extension and open a project folder
2. Open the **Recall** view in the activity bar
3. Chats index automatically; use the refresh icon to reload
4. Right-click a chat:
   - **Restore into Cursor History** — show it in Cursor again (quit & reopen Cursor afterward)
   - **Export for @Files** — write Markdown under `.recall/exports/` and copy to clipboard
   - **Open Chat** — preview messages

## Develop

```bash
npm install
npm run compile
```

Press **F5** to launch an Extension Development Host.

```bash
npm run package
```

Creates a `.vsix` you can install with `cursor --install-extension cursor-recall-0.1.3.vsix`.

## Privacy

Recall reads Cursor’s local chat database (via a temporary copy) and stores its own index in the extension’s global storage. Restoring into Cursor updates Cursor’s local indexes after creating a backup. Chat content is never uploaded.
