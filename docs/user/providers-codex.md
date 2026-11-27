# Codex

Use your ChatGPT plan or an existing Codex CLI login to run Codex in T3 Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers** (select your target environment first for remote machines). T3 Code manages the Codex runtime and signs you in via OpenAI.

For a runtime managed by T3 Code, **Settings → Providers → Codex runtime → Update Codex**
installs the version supported by your T3 Code release. Update T3 Code first when a newer
managed runtime is needed. A Codex bundled with ChatGPT is updated through ChatGPT.

Manage shared usage and credits in ChatGPT through **Manage usage** in T3 Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

Fast and Ultrafast speeds are unavailable with this connection. To use the speed
options your account supports, [use an existing Codex login](#use-an-existing-codex-login).

When reconnecting, choose the same account in T3 Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

Run `codex login` on the environment's machine, then add a Codex instance in **Settings → Providers** via **Configure manually**. See [provider setup](./install.md#providers) for installation details.

For a custom API provider such as Sub2API, T3 Code uses that service's model catalog
with the instance's Codex configuration and variables. In **Settings → Providers → Models**,
use **Sync models from provider** after the service's available models change.
Manually added models and their options are kept when you sync.

## Use an API key

In **Settings → Providers → Add provider**, choose **Codex → API Key**. Enter the
service's Responses API base URL, an API key (or a secret reference), and the exact
model IDs supplied by that service. Keep any path prefix such as `/v1`; do not
include `/responses`. T3 stores the key as a secret and isolates this connection
from your CLI and ChatGPT login.

**Check connection** requests the model list without generating tokens. A successful
check does not prove inference access. **Test model** makes a small, billable Responses
API tool round trip and runs only when you choose it. Services without a model-list
endpoint can still be configured with manually entered model IDs.

**Connection method** chooses credentials; **Runtime source** chooses the executable.
Changing only the runtime source keeps the current connection. Instances on the same
environment share one T3-managed Codex installation and its updates, while keeping
their credentials and BYOK state separate. Claude installations are shared separately.
This does not share agent processes across accounts. Finish or stop active turns and
sign-in before changing connection settings.

## Allow more time for provider checks

If an authenticated Codex installation reports “Timed out while checking Codex
app-server provider status,” set `T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` in the
T3 server's environment and restart it. See [Provider check timeouts](./install.md#provider-check-timeouts)
for configuration and other providers.

## Generate images

Codex can generate images directly in a T3 Code thread when your Codex version,
model, and account support native image generation.

If Codex reports that its image tool is unavailable, image generation may be
disabled in its configuration. In **Settings → Providers**, edit your existing
Codex provider and add this to **Launch arguments**, keeping any other arguments:

```text
-c features.image_generation=true
```

This enables the feature for that T3 Code provider without changing your shared
Codex configuration. You do not need another provider instance or a separate image
API key. The flag does not add image support to an unsupported model or account.

Launch arguments apply to Codex sessions started after you save them. Start a new
thread with the same Codex provider and ask it to generate an image. The completed
image appears in the thread.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, or configure multiple CLI logins with a **shadow home** so work and personal accounts can continue the same threads:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | _(leave empty)_     |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

- Both instances must share the same **CODEX_HOME path**. Keep the shadow directory fresh—don't copy your full Codex home into it.
- The shadow account needs file-based credential storage (`auth.json`); see [OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).
- Use a separate **CODEX_HOME path** (no shadow home) if you want completely isolated sessions.

To switch accounts mid-thread, pick another compatible Codex instance sharing the same **CODEX_HOME path** from the model picker.

## Features and options

- **Image generation**: Supported when your Codex version, model, and account allow it. If disabled in Codex config, add `-c features.image_generation=true` to the instance's **Launch arguments** (applies to new sessions).
- **Async questions**: Codex can ask a question while continuing to work; answer in the question panel (steers the active turn or starts a new one) or dismiss it without sending.
- **App access approvals**: Respond to external app access requests directly in chat (one-time, session, or permanent depending on the tool).
- **MCP OAuth sign-in**: Click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into **Finish sign-in** (requires provider management permission).
- **Daybreak**: Models with cyber access programs show a **Cyber Access** option (`Standard` or `Daybreak`, initialized from `daybreak = true` in `config.toml`).
- **Usage limits**: Limit stops display the exhausted window, reset time, and (on workspace plans) whether credits or spend limits need adjustment.
- **Feedback to OpenAI**: Send `/feedback <description>` in an existing Codex thread to upload conversation and Codex logs to OpenAI.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Fast mode

With **Use an existing Codex login**, select **Fast** in the model's speed options.
T3 Code shows the tiers advertised by that model and account, including Ultrafast
when available. Reasoning effort is a separate setting; choosing a lower effort
does not select Fast mode.

Accounts connected through T3 Code's **Connect with ChatGPT** flow use subscription
sharing, which does not accept service tiers. T3 hides the tier selector for these
accounts. To explicitly select Fast, add an instance using an existing Codex CLI
login instead. Adding a tier to a custom model does not enable it for a managed account.

The Codex terminal's `/fast` command is not a T3 composer command. Use the model's
speed options in T3. For CLI defaults, set `service_tier = "fast"` at the top level of `config.toml`
and `fast_mode = true` under `[features]`. An explicit thread selection
takes precedence over a default. Availability and additional usage depend on the
model and account; see [OpenAI's speed guide](https://learn.chatgpt.com/docs/agent-configuration/speed).

## Goals

Codex goals work through T3's composer: send `/goal <objective>`, `/goal` to view it,
or `/goal pause`, `/goal resume`, and `/goal clear`. Send the command without
attachments. See [Goals](./composer.md#goals) for continuation and Stop behavior.

T3 treats `/goal edit` as viewing the current goal, rather than opening the Codex
terminal's editor. Send `/goal <new objective>` to replace it; this resets the
goal's usage accounting. The composer does not parse a token-budget flag.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Sign in to an MCP server

When an MCP server you added to Codex needs you to sign in, the thread shows a notice with
**Sign in**; on mobile, tap the notice. Approve access on the page it opens. Your browser then goes
to a page that may not load, especially when Codex runs on another machine: copy that page's
address, paste it into T3 Code, and choose **Finish sign-in**. Codex reconnects the server in that
thread and keeps the sign-in for other threads on the same Codex instance; an instance with its own
home, such as a second account, may need to sign in separately. Signing in needs permission to
manage providers.

## Use the OpenAI Chrome extension

Connecting ChatGPT in **Settings → Providers** signs in the Codex provider.
Using your signed-in Chrome profile through the extension requires a browser
connection for the current Codex thread.

If a T3 Code thread reports `The browser access host is unavailable`, its browser
host is unavailable; this does not identify an extension connection failure.
For a task that requested Chrome, follow [OpenAI's setup guide](https://learn.chatgpt.com/docs/chrome-extension),
then select Chrome in a Codex chat in the ChatGPT desktop app.
If the task runs on a remote environment, `localhost` in the desktop browser
refers to your computer. Forward the remote page's port or use a URL reachable
from your computer before repeating the task. Connecting to T3 Code through a
relay or tunnel does not by itself expose that page. T3 Code's built-in browser
preview uses its own browser session.

## Use Daybreak

Models with cyber access programs show a Cyber Access option in the model
options. It starts on Standard, or on Daybreak when `config.toml` in your Codex
home sets `daybreak = true` or the model only runs under Daybreak. Your choice carries
over to new threads. Custom models do not offer it. If Codex rejects a turn
because your login lacks the program, switch Cyber Access back to Standard or
sign in to Codex with an account that has it.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
