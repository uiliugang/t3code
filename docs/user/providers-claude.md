# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Multiple accounts and presets

Isolate separate Claude accounts or router presets with distinct `CLAUDE_CONFIG_DIR` directories:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add a second Claude instance in **Settings → Providers** (or **Add Claude account** on mobile) pointing **CLAUDE_CONFIG_DIR path** to `~/.claude_personal` (leave empty for the default directory). Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

On mobile, tap **Add Claude Code** in **Settings > Providers**, then edit the account's
config folder. The login itself still happens on the environment's machine.

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

File paths in the `--settings` and `--append-system-prompt-file` launch arguments
can start with `~` for the home directory of the machine running T3 Code. Any
other relative path is read from the thread's project folder, or its worktree.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

- **When you return** shows the **Compact** chip described above. This is the default.
- **Before the cache expires (beta)** tries to compact an idle thread shortly before its
  prompt cache expires, while the history is still cached.
  The compaction appears in the thread as a `/compact` turn sent by T3 Code.
  If the window is missed, such as when you enable this mode after the cache has
  expired or the server restarts before compaction runs, it falls back to
  **When you return**. Switch the chip to **Keep** to keep the full history for that message.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Steering

A steer waits until Claude finishes the tool calls it is running, then Claude reads it
in the same turn. The message shows as unread until then. If Claude drops it before
reading it, the message is sent as the next turn, after any messages queued before it.
If Claude exits or the server restarts first, the message waits in the queue in that
same place until you resume it. If you press Stop, T3 Code shows a notice with the text
of any steer Claude had not read.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins,
and plugins synced from your claude.ai account, also contribute skills under
names such as `plugin:review`. Skills marked `disable-model-invocation` can
still be started by you. Invoke those one per message: Claude directly runs only
the last named skill and may try to start earlier ones through its Skill tool,
which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

## Custom API providers

Add **Claude** in **Settings > Providers**, then select **API Key** as its connection method.
Account and API connections keep their own saved settings and credentials; switching back
restores them. Save or revert pending edits before switching.
Select **Anthropic Messages** or **OpenAI Chat Completions**, enter the service's base
URL, and add its exact, case-sensitive model IDs. For Chat Completions, include the
API prefix (for example, `https://api.example.com/v1`); T3 Code runs a local protocol
converter on the environment automatically. Both credential choices use Bearer
authentication upstream in this mode. Anthropic mode supports Bearer Token or API Key
(`x-api-key`). Credentials are stored
on the selected environment; secret references are supported on web and desktop.
The API connection uses an isolated Claude config directory and lists only your models.
Install Claude Code on the environment or choose its executable under **Runtime**.

Save connection changes before checking them. **Check connection** initializes Claude
Code and tries the optional model-list endpoint without inference. An unavailable list
leaves authentication unverified. **Test model & tools** beside each model sends two requests, uses API
credits, and checks streamed output and an echo tool round trip. Neither check proves
that every Claude Code feature is supported by your service.

BYOK does not load user or project settings files into Claude Code, so their environment
overrides cannot replace the configured endpoint or credentials. Put required runtime
options in this instance. Main and auxiliary model requests stay on your configured
models. Removing a selected model requires choosing another before sending. Use a new
instance for a different BA service rather than moving an existing conversation.

On mobile, **Settings > Providers** also supports creating, editing, disabling, and
checking API connections. Choose the model to test beside its name.

Chat Completions mode supports text, images, streamed responses, and function tool
calls. The upstream model must support function calling. Anthropic-specific server
tools and document blocks are not supported by the converter.

To run the converter separately from the repository, set `OPENAI_BASE_URL`,
`OPENAI_API_KEY`, and `T3_PROXY_TOKEN` in your shell, then run:

```sh
node apps/server/scripts/claude-openai-proxy.ts
```

It listens on `127.0.0.1:8318` (`PORT` overrides the port). Configure an **Anthropic
Messages** BYOK instance with that local base URL and `T3_PROXY_TOKEN` as its credential.
Run the converter on the same environment as Claude Code. Stop it with Ctrl+C.

For an external Anthropic gateway, you can also configure a regular Claude instance:

In **Settings > Providers**, add a Claude instance and give it a separate config directory,
such as `~/.claude_gateway`. Keep **Binary path** set to `claude`. Set the instance's
**Environment variables** using the authentication method required by your gateway:

| Variable               | API-key authentication           | Bearer-token authentication      |
| ---------------------- | -------------------------------- | -------------------------------- |
| `ANTHROPIC_BASE_URL`   | The gateway's Anthropic base URL | The gateway's Anthropic base URL |
| `ANTHROPIC_API_KEY`    | Your API key, marked Sensitive   | An explicitly empty value        |
| `ANTHROPIC_AUTH_TOKEN` | An explicitly empty value        | Your token, marked Sensitive     |

Use the base URL given by the gateway, not the full `/v1/messages` request URL. If the
config directory already has a subscription login, sign out of that directory in Claude
Code first. You do not need to sign in to Anthropic for a gateway that uses its own credentials.

Add the gateway's exact model ID with **Add custom model**, then select that model in a
new thread using this Claude instance. A display label does not change the model ID sent to
the gateway. Keep unsupported effort or thinking options off according to the gateway's
model documentation. `ANTHROPIC_DEFAULT_*_MODEL` alias settings do not override the model
explicitly selected in T3 Code.

For a remote environment, the endpoint must be reachable from the server. `localhost`
means the server itself, and credentials are saved on that environment. Values marked
Sensitive use its secret storage. Configure separate instances for different gateways.

A ready status is not proof that a gateway accepts the key or model. Send a small
prompt and check the gateway's
request log or usage dashboard. Custom endpoint settings show **Custom API endpoint**;
cached Anthropic subscription identity and subscription limits do not describe that gateway.

## Sign in to an MCP server

When an MCP server you added to Claude needs you to sign in, the thread shows a notice with
**Sign in**, once per session; on mobile, tap the notice. Approve access on the page it opens. Your
browser then goes to a page that may not load, especially when Claude runs on another machine:
copy that page's address, paste it into T3 Code, and choose **Finish sign-in**. Claude keeps the
sign-in and reconnects the server. Connectors you added on claude.ai are signed in on claude.ai,
so T3 Code doesn't ask about them. Signing in needs permission to manage providers.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
