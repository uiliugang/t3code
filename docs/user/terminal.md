# Terminal

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the environment that launches the T3 Code server
to choose the executable used for new terminals. Use an executable name or its
full path, without surrounding quotes or command-line arguments. An unset or
blank value keeps the platform default. If the executable cannot be started,
T3 Code tries its usual fallback shells.

On Windows, to use Git Bash from a standard Git for Windows installation, run
this in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('T3CODE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

Fully quit T3 Code, then reopen it from the Start menu and create a new terminal.
If the app still inherits the old environment, sign out of Windows and sign in
again. Git Bash starts as an interactive login shell. Use `bin\bash.exe`, not
`git-bash.exe`, which launches a separate terminal window.

To restore the default, remove the variable with the same command using `$null`
as its second argument, then restart T3 Code.

This setting belongs to the machine hosting the server, including when you
connect from another device. It does not change provider-run commands or the
shell used by automatic project setup and settle scripts.

## Codex and Claude commands

In T3 terminals using zsh or bash on macOS or Linux, enter `codex` or `claude`
to use the linked thread's provider account and model. During an active turn,
the command uses that turn's selection. Each invocation starts an independent
native conversation; it does not resume the thread's running agent.

To use the same behavior in your system terminal, run `t3 terminal install`
once, then open a new terminal. Without a linked thread, commands use the model
selected in T3's default-model settings. T3 must be running on that machine.
Use `--base-dir /path/to/t3-home` when connecting to a different local T3 home,
or `--rc-file /path/to/startup-file` for a custom zsh/bash startup file.

`codex` always launches Codex and `claude` always launches Claude. A mismatch,
missing instance, or signed-out account produces an error. Choose another
instance explicitly with `codex --t3-instance <instance-id>` or
`claude --t3-instance <instance-id>`. Native arguments such as `--model` and
explicit resume commands are passed through; an explicit model takes priority.
Changing the thread or default model affects the next invocation.

The integration defines shell functions without replacing installed binaries.
`command codex` or `command claude` bypasses it. To remove the system-terminal
integration, run `t3 terminal uninstall` with the same `--rc-file`, if used,
then open a new terminal. Other shells and Windows retain their existing behavior.
Remote clients use the terminal's server and its provider accounts.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

On iPhone and iPad, long-press the terminal to paste or to choose Select Text.
Select Text shows the visible output, where you can copy text or tap a link.

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
