# Messages and context

Use the composer to send prompts, attach files, reference threads or pull requests, invoke skills, and steer or queue follow-ups.

## Limits and large pastes

- **Message length**: Up to 120,000 characters.
- **Large pastes**: Pasting 32 KiB+ of text (or any paste that would exceed the message limit) turns it into a text-file attachment so it doesn't bloat the prompt. Use `Cmd+Shift+V` (Apple) or `Ctrl+Shift+V` (Windows/Linux) to paste inline instead.

## Formatting

The composer renders Markdown live as you type and reveals raw markers when your cursor enters styled text. The agent receives the exact Markdown you typed.

- Disable live styling in **Settings → Chat → Rich text composer**.
- Standard Markdown triggers (`- `, `1. `, `- [ ] `, `> `, `# `, `---`, and ` ``` ` + Enter) create lists, quotes, headings, rules, and code blocks.
- In lists/quotes, `Shift+Enter` continues (or exits on an empty line), and `Tab` / `Shift+Tab` indents or outdents.
- In code blocks, `Enter` keeps indentation, `Tab` / `Shift+Tab` indents selected lines, and closing ` ``` ` + Enter (or two blank lines) exits the block.

## Attach files

Attach up to **100 files** per message:

- **Images**: Up to 10 MiB each, 80 MiB total per message. HEIC/HEIF photos are converted to JPEG, and oversized photos are resized automatically.
- **Other files (including videos)**: Up to 50 MiB each (subject to environment limits). Video attachments pass a file path; only [Antigravity](./providers-antigravity.md#skills-and-attachments) sends supported videos natively to Gemini models.

Files upload to the environment's machine as soon as you attach them, and all uploads must finish before sending. Provider and model limits still apply.

- **Web and desktop**: Drag, paste, or pick files. Reloading before an upload finishes requires re-attaching.
- **Mobile**: Pick files, share into T3 Code via the system share sheet, or drag images in Android split screen.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

Choose your default follow-up behavior in **Settings → Chat → Follow-up behavior** (per client):

- **Queue**: Holds the message on the server for the next turn.
- **Steer**: Injects the message into the running turn (when supported by the agent).

Shortcuts while a turn is running:

- **Opposite action**: `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) uses the non-default action. If your send shortcut already requires `Cmd/Ctrl+Enter`, add `Shift`. On mobile, long-press the send button or use `Cmd/Ctrl+Return` on a hardware keyboard.
- **Steer oldest queued message**: `Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows/Linux) sends the first queued message as a steer without touching your current draft. Remap `thread.steerQueuedMessage` in **Settings → Keybindings**, or add a rule in your [keybindings file](./keybindings.md#edit-the-configuration-file) to trigger it on `mod+enter` when the composer is empty:

```json
{
  "key": "mod+enter",
  "command": "thread.steerQueuedMessage",
  "when": "composerFocus && turnRunning && composerEmpty"
}
```

- **Edit most recently queued message**: `Option+Up` (macOS) or `Alt+Up` (Windows/Linux) at the start of the composer (`thread.editQueuedMessage`).

Slash commands (such as `/compact` or `/context`) wait for the current turn to finish rather than steering into it. [Goal](#goals) commands are the exception.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments so you can preview them and queue messages offline. Uploads resume on reconnect, and drafts/queued messages survive app restarts and T3 Connect sign-out (restored when signing back into the same account).

## Custom models and defaults

- **Remembered defaults**: T3 Code remembers your last provider, model, and options for new threads. A project's configured model overrides this. Leaving reasoning level or service tier unset uses the provider's default.

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

Edit a custom model to change its **Request model ID (slug)** separately from its display name.
Model IDs are case-sensitive. After changing an ID, select the updated model in existing threads
and default model settings that used the old ID.

To rename a built-in model on every client, edit the server's `settings.json` in its `userdata`
directory. Add a custom model entry with the built-in model ID and a new name under that provider
instance:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Quote an assistant response

- **Web and desktop**: Select text in an assistant message and click **Cite in composer**. Click the pencil on the chip to add or edit a comment; click the chip to jump back to the source.
- **Mobile**: Long-press an assistant response, select text, and tap **Cite**. Tap a quote chip to edit its comment, remove it, or jump to the source message.

Quoted text and comments count toward the message length limit and are preserved across copy/paste and [stashed prompts](#prompt-stash).

## Recall a sent prompt

Press `ArrowUp` in an empty composer to cycle backward through earlier prompts in the thread, and `ArrowDown` to move forward. Only prompt text is restored (not attachments or context chips). Editing a recalled prompt turns it into a normal draft.

## Suggested next prompt

Open **Settings → Chat → Composer** to enable suggestions after a turn and choose which source
to try first for the environment. T3 Code tries the other source if the first is unavailable,
fails, or provides no suggestion. An empty composer shows the suggestion. Press `Tab` to accept
or `Escape` to dismiss.

- **Native suggestions** use Claude or Codex. The provider may prepare one after a turn and
  use a cached request against your plan even if you prefer the text generation model. Claude
  skips the first turn and turns near usage limits. Codex requires CLI 0.165+.
- **Text generation model** uses the environment's configured text generation model and counts
  toward that model's usage.

Restart running Claude sessions after changing suggestion settings. Until restarted, those
sessions may still request native suggestions.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to put the workspace back
to its checkpoint from before that message. That also undoes edits you made yourself.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. Completed subagents belonging to the reverting
thread do not block restoring that same worktree, provided they have no queued or
active work, pending requests, or background tasks. A thread that works in the project
directory rewinds the conversation only. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt. You can edit while the
conversation rewinds; sending becomes available when it finishes. If rewinding
fails, your edits stay in the composer.

- **Revert and keep changes**: Rewinds the conversation only.
- **Revert files too**: Restores workspace files to the checkpoint before that message (including your own edits). Only available for worktree threads when no other thread or active session shares that directory.

Rewinding removes later messages from the active thread and provider history (requires provider rewind support), but cannot undo external actions or separate provider memory.

## Prompt stash

On web and desktop, press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) to stash the current draft and its attachments (wait for uploads to finish first). Press the same shortcut in an empty composer to restore the stash (or open the stash menu if you have multiple).

- Holds up to 100 prompts in browser storage; stashes are never auto-deleted.
- Stashes with uploaded files must be restored in their original environment. Uploads expire after 24 hours; use **Attach again** or remove expired files before sending.

## Voice input

Dictate into the composer with the microphone button or `mod+shift+d` (web and desktop). Audio stays on-device or goes only to an environment/provider you explicitly choose in **Settings → Voice**. See [Voice input](./voice-input.md) for setup, mobile dictation, and microphone priority.

## Queued messages

Queued messages appear at the end of the thread (web/desktop) or above the composer (mobile). From a queued message you can:

- **Send now**: Injects it immediately into a running turn (or moves a slash command to the front of the queue).
- **Edit**: Opens the message and its attachments in the composer without losing your existing draft.
- **Remove**: Cancels the queued message.

If you stop the agent or the server restarts, queued messages pause in order. Click **Resume** in an empty composer (or send a new message) to continue. When the provider supports native continuation, **Resume** continues without sending a new prompt.

## Commands and skills

Type `/` for commands or `$` for skills from the selected environment and provider.

The slash menu also includes skills unless you turn off **Settings → Chat →
Show skills in slash menu**, under Advanced. Only skills enabled for the provider are listed.

After you add or change skills, plugins, or MCP servers, use **Restart agent
session** in the command palette on web and desktop. The conversation continues,
and your next message starts the agent again with the new setup.

Provider commands must start the message to run. T3 Code commands such as
`/model` and skill mentions work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it.

Send `/clear` on its own, or pick it from the slash menu, to start a fresh session
in the same thread. Your next message goes to a new provider session that doesn't see the
earlier messages, and the thread marks where it began with **New session**.
Earlier messages and diffs stay in the thread. Dismiss the notice above the
composer to keep the current session instead.

On web and desktop, turn on **Context window** in **Settings → Appearance →
Thread details** to see context usage in the thread details card. It appears
once the provider reports usage.

The composer also shows a context meter by default. Toggle **Context window indicator**
in **Settings → Chat** to hide it. Open the meter for token details and **Compact context**
when the provider supports compaction.

Claude instances can also compact idle threads for you. See
[compact long conversations](./providers-claude.md#compact-long-conversations).

## Goals

With Codex, Claude, and OpenCode 2.2.5+, send `/goal <criteria>` (for example, `/goal all tests in packages/api pass`) so the agent keeps working across turns until the goal is met.

- `/goal` shows the current goal; `/goal clear` removes it.
- Codex and OpenCode support `/goal pause` and `/goal resume` (stopping pauses the goal).
- On Claude, stopping ends the current turn but keeps the goal active for your next message.
- Sending a new goal or `/goal resume` while working interrupts the current turn unless queued; `/goal clear` and `/goal pause` interrupt only when the agent is actively working on the goal.

## Context in your message

Attached context—files, terminal excerpts, diff/file review comments, preview annotations, pull requests, and threads—appears as inline chips at your cursor. Click a chip to inspect or open its source; copy/paste and [Prompt stash](#prompt-stash) preserve chips across drafts.

- **Pull requests (`#`)**: On web and desktop, type `#` to browse recent PRs in the current repository (linked PRs appear first), type digits to match by number, or type a word to search by text.
- **Threads (`@`)**: Type `@` and part of a thread title to reference a thread on the same server (or on a linked machine when Linked environments is enabled). You can also drag threads from the sidebar onto the composer, or paste a copied thread link. The prompt carries only a reference—the agent reads the thread on demand. Dropping a thread from an unlinked environment attaches a snapshot transcript file instead.
- **Models (`@`)**: Type `@` and part of a model or provider name (e.g. `@opus` or `@opus:opencode`) to reference a model in your prompt (such as for delegation) without changing the thread's model.
- **Images vs. files**: Images keep a thumbnail shelf above the composer plus optional inline chips; files live only as inline chips (deleting the last chip removes the file).

## Attached files

Select any file chip in a draft or sent message to preview it (syntax-highlighted code/JSON, rendered/raw Markdown/HTML/CSV/TSV, audio playback, and ZIP folder browsing up to 50 MB). Large text files show a truncated preview—save the file to read it in full.

## Images and videos in messages

Select an image or video attachment or link to preview it.

- **Web and desktop**: Right-click media to save it or copy its path/URL.
- **Mobile**: Long-press a thumbnail and choose **Save or share**.

File links point to the file on the environment's machine, so moving or deleting the original breaks the preview—save a copy if you need to keep it.

## Files outside the workspace

Following an agent's file link to a file outside the workspace opens it read-only. External HTML files cannot load neighboring scripts, styles, or images.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your T3 Code session.

The file viewer recognizes images, HTML, and PDF files by their filename extension,
including filenames or folders containing `#` or `?`.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.

## Predicted messages

Enable **Show predicted messages** in **Settings → Chat** to suggest your next message after an agent finishes. Press Tab or use the accept control to put the suggestion into an editable draft, then send it yourself. On mobile, tap **Use prediction**. Typing your own message or dismissing a suggestion leaves you in control of the draft.

Predictions use the current conversation and your project’s text generation model. They are on by default and count toward that model’s usage.
