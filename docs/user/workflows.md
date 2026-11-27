# Workflows

Workflows (Labs) are durable TypeScript scripts that chain agents, code steps, schedules, webhooks, issue/PR triggers, and human approvals into multi-stage runs that survive server restarts. Each completed step is checkpointed so restarts resume where they left off.

Use a **scheduled task** for a single prompt on a timer or webhook; use a **workflow** for multi-stage pipelines (e.g., triage → fix → approval → release).

## Enable workflows

Turn on **Settings → Labs → Workflows** on the server that will run them (or set `"workflowsEnabled": true` in `~/.t3/userdata/settings.json` on headless servers). Existing runs pause while disabled and resume when re-enabled.

## Create a workflow

Place `.ts` files in `~/.t3/workflows/` (or the path in `T3CODE_WORKFLOWS`). The server watches the folder and hot-reloads valid edits.

- **With an agent (recommended)**: Copy the [`t3-workflows` skill](https://github.com/pingdotgg/t3code/blob/main/skills/t3-workflows/SKILL.md) into your agent's skills folder (e.g. `~/.claude/skills/` or `~/.agents/skills/`) and describe what you want.
- **Directly**: Edit files in `~/.t3/workflows/` or use **Definitions** on the Workflows page (**Open workflows** in the command palette; saving/deleting in the app requires terminal access).

Example (`~/.t3/workflows/release.ts`):

```ts
const { workflow, step, ask, stop, title } = T3;

export default workflow(
  "release",
  { version: 1, payload: Schema.Struct({ name: Schema.String }) },
  Effect.fn(function* (payload) {
    yield* title(`Release ${payload.name}`);
    const notes = yield* step("notes", { returns: Schema.String }, Effect.succeed("3 fixes"));
    const answer = yield* ask("ship", {
      title: `Ship ${payload.name}? ${notes}`,
      choices: ["Ship", "Hold"],
    });
    if (Option.isNone(answer) || answer.value.choice !== "Ship") return yield* stop("held back");
    return { shipped: payload.name };
  }),
);
```

- `T3`, `Effect`, `Schema`, and `Option` are globals—no imports needed.
- Filenames may use letters, digits, `-`, `_`, and `.`. Dot-files and subfolders are ignored (put shared helpers in a subfolder; restart the server after editing imported helpers).
- **Versioning**: Keep older workflow versions defined while they have unfinished runs; bump `version` to deploy new steps alongside active runs.

## CLI commands

```sh
t3 workflow start <name> --input '<json>' --key <key>
t3 workflow list [--status paused] [--tag <tag>] [--subject <url or id>]
t3 workflow show <run>
t3 workflow resume <run>
t3 workflow cancel <run> [--reason '<why>']
t3 workflow questions [--kind <kind>]
t3 workflow signal '{"choice":"yes"}' --run <run> --wait <name>
t3 workflow signal '<json>' --workflow <name> --channel <channel>
t3 workflow withdraw --run <run> --wait <name> [--reason '<why>']
t3 workflow hooks
t3 workflow store list
t3 workflow store set <key> '<json>'
```

- `--key` deduplicates starts across retries and version bumps.
- `signal` answers an open question or wakes a channel wait. A signal for a closed question is kept for a later wait rather than refused, so check `t3 workflow questions` before answering. Signals sent before a channel wait are buffered for 7 days by default.
- `withdraw` cancels an open question so `ask` returns `None`.
- `store` reads/writes shared state persisted between runs.

## Questions, tags, and subjects

- **Question kinds & tags**: Declare `asks: { kindKey: "Label" }` in workflow options and pass `kind` to `ask(...)` to filter open questions under **Needs you** (and `t3 workflow questions --kind <kind>`). Use `tags([...])` to label runs for filtering.
- **Rich choices & links**: Pass `links: [{ label, url }]` and choice objects `{ value, description, requireReason }` to require an explanation before answering. Answers record `answeredAt` and `answeredBy`.
- **Subjects**: Call `subject(issueOrPrOrThreadOrUrl)` (or pass `{ subject }` to `start(...)`) to display and link the target item in run lists, issue/PR views, and `t3 workflow list --subject <url>`.

## Concurrency limits

- **Whole-workflow cap**: Set `concurrency: 4` in workflow options.
- **Step pools**: Wrap a section in `within("builders", { limit: 4 }, ...)` (`limit: 1` acts as a lock). Waiting runs show as **Queued** in FIFO order; resumed runs re-acquire their pools first.
- Avoid nesting `within` on the same pool name (or a workflow's own concurrency pool), and avoid holding a lock across `invoke` if the child needs the same pool. Step names starting with `@pool:` are reserved.

## Triggers

- **Schedules:** `every` runs on an interval, starting one interval after the workflow loads; `daily` runs at a local time of day (a time missed by more than 10 minutes while the server is down is skipped).
- **Webhooks:** Run `t3 workflow hooks` on the host. For a path starting with `/api/hooks/`, prepend your server's address. A host running with `T3CODE_NOISE_ONLY=true` and linked to T3 Connect prints a `t3hook://` address instead. Save that address in a private file and send events with `t3 webhook send --address-file ./hook.address --body-file ./event.json`. Share the address only with the sender: it contains the hook's secret. A retry with the same delivery header (such as `X-GitHub-Delivery`) starts no second run. The plain body or complete encrypted delivery must fit within 1 MiB. A hook starts at most 60 runs per minute; on `429`, retry after 60 seconds. Organization policies that block webhook tasks block workflow webhooks too.
- **Issues and pull requests:** workflows can start on new issues or pull requests and read, comment on, or update them via **Settings → Source control & issues** — no webhook needed. T3 Code checks roughly once a minute, and only items opened after the workflow was first loaded start runs.

## Follow runs, agent threads, and failures

Open **Open workflows** from the command palette (web/desktop) to filter **Needs you**, **Running**, or **All**, inspect agent threads, answer questions, resume, or cancel runs.

- **Agent steps**: Each `agent` step runs in a regular thread (hidden from sidebar lists) that you can open live from the run. Supports custom `workspace`, `runtimeMode`, `interactionMode`, `title`, typed `returns`, and [linked environments](./remote-access.md#link-another-environment).
- **Retries & pausing**: Failed code steps auto-retry after 5, 20, and 80 minutes (or immediately on **Resume**). Failed or timed-out agent steps pause for manual resume (offline-start failures auto-retry). Cancelling stops active agent turns and child runs permanently.
- **Skipped runs**: Up to 500 skipped top-level runs are kept per workflow (configurable via **Settings → Labs → Skipped runs kept** or `"workflowSkippedRunsKept"` in `settings.json`).
- **Always-on requirement**: Runs only advance while the server that started them is online.
