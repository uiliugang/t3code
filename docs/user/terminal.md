# Terminal

T3 Code includes integrated terminals running on the environment's host machine, with persistent scrollback across reconnects.

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the T3 server's environment to an executable name or full path (no quotes or arguments) to override the platform default shell for new terminals. This does not affect agent commands or project setup/settle scripts.

## Scrollback and navigation

Each terminal retains up to **5,000 lines** and **8 MiB** of scrollback on the server.

| Action                     | macOS                              | Linux / Windows browser                    |
| -------------------------- | ---------------------------------- | ------------------------------------------ |
| Scroll page up/down        | `Shift+PageUp` / `Shift+PageDown`  | `Shift+PageUp` / `Shift+PageDown`          |
| Jump to start / latest     | `Cmd+Shift+Home` / `Cmd+Shift+End` | `Ctrl+Shift+Home` / `Ctrl+Shift+End`       |
| Select all retained output | `Cmd+A`                            | `Ctrl+Shift+A` (`Ctrl+A` stays shell home) |
| Next / previous terminal   | `Cmd+Shift+]` / `Cmd+Shift+[`      | `Ctrl+Alt+]` / `Ctrl+Alt+[`                |

On iOS/iPadOS, long-press the terminal to paste or choose **Select Text**.

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
then open a new terminal. Other shells retain their existing behavior.
Remote clients use the terminal's server and its provider accounts.

## fish shell

T3 Code launches `fish` with `no-query-term` to avoid startup delays, which overrides universal `fish_features`. To keep custom flags or re-enable `query-term`, export `fish_features` in the environment that launches T3 Code.
