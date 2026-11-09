# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

On mobile, tap **Add Claude account** in **Settings > Providers** and enter a name and the
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

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Claude Code also
compacts automatically. To see context usage, see
[commands and skills](./composer.md#commands-and-skills).

When you return to a large thread after Claude's prompt cache expires, a
**Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Keep** and keep the full
history for that message. The mobile app shows no chip: an eligible message sent
from it summarizes first. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Providers > Advanced** controls this for threads
over 200,000 tokens. Each Claude provider's settings can override it:

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

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins also
contribute skills under names such as `plugin:review`. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

## Custom API providers

Choose **Claude > Claude · BYOK** when adding a provider in **Settings > Providers**.
Select **Anthropic Messages** or **OpenAI Chat Completions**, enter the service's base
URL, and add its exact, case-sensitive model IDs. For Chat Completions, include the
API prefix (for example, `https://api.example.com/v1`); T3 Code runs a local protocol
converter on the environment automatically. Both credential choices use Bearer
authentication upstream in this mode. Anthropic mode supports Bearer Token or API Key
(`x-api-key`). Credentials are stored
on the selected environment; secret references are supported on web and desktop.
The preset creates an isolated Claude config directory and lists only your models.
Install Claude Code on the environment or choose its executable under **Runtime**.

Save connection changes before checking them. **Check connection** initializes Claude
Code and tries the optional model-list endpoint without inference. An unavailable list
leaves authentication unverified. **Test model & tools** sends two requests, uses API
credits, and checks streamed output and an echo tool round trip. Neither check proves
that every Claude Code feature is supported by your service.

BYOK does not load user or project settings files into Claude Code, so their environment
overrides cannot replace the configured endpoint or credentials. Put required runtime
options in this instance. Main and auxiliary model requests stay on your configured
models. Removing a selected model requires choosing another before sending. Use a new
instance for a different BA service rather than moving an existing conversation.

On mobile, **Settings > Providers** also supports creating, editing, disabling, and
checking BYOK instances. The mobile tool check uses the first configured model.

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

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
