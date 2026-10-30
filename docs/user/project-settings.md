# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

With a project selected, a provider's switch in **Settings → Providers** turns it on or off for
that project only, in either direction: a provider off on the machine can be used in one project,
and one on everywhere can be kept out of another. That project's model pickers follow the switch,
and no new turn there can start on a provider it turned off, including queued messages and
follow-ups from delegated tasks. A turn already running when the switch flips finishes. A delegated
task's result still lands in its parent thread, which sees it on its next turn. Reset returns the project to the
machine's setting. Every other provider setting stays per machine.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the server-setting pages, such as Threads, Source control and Worktrees, edit the selected
environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Repository groups

Choose **Create group** beside **Add project** in the sidebar, or search for it in the
command palette. Choose an environment, name the group, select 1–16 existing repositories
or enter their directories, and choose the primary repository. Creating a group keeps the
existing projects and opens a new task with **Worktree** selected.

In **Settings → Projects → Repositories**, you can later edit the directories for the repositories
that belong to a task, such as a frontend and backend. Give each a name and short context,
choose the primary repository, and save. Paths refer to the selected environment's machine;
remote clients configure that machine's directories. Codex and Claude support these groups.
Other providers refuse a multi-repository task until their adapter supports it.

New tasks use the saved repositories. Existing tasks keep their original directories, even
when project settings change. The primary repository is the default directory. Choose **Worktree**
for a new task to create an isolated checkout for every repository. Each repository can have
its own base branch and setup command; the agent starts after the entire group is ready.
A failed setup retains the prepared checkouts so retry can continue without discarding work.

In an action's configuration, **Run in repositories** selects where it runs. All repositories
are selected by default. A selection applies to manual runs, worktree setup and settle actions,
using the repositories bound to that task. Each repository gets its own terminal. A group
setup action takes precedence over individual repository setup commands; it finishes across
all selected repositories before the agent starts.

Thread details group branch, stack, pull requests, commit actions, and changes by repository.
Collapsed repositories keep their branch and change totals visible. Choose a repository before
viewing its diff, opening its terminal, or opening it in an editor. A commit or push affects
that repository. Project actions follow their configured repository selection.

File restore checks and backs up the whole group. Close its terminals first. Shared checkouts
cannot be restored; rewind the conversation without files instead. If recovery is required,
inspect every repository and use **Group recovery**. Accepting current files preserves them
and starts a fresh provider conversation, while keeping backups and earlier history.

Automatic group cleanup runs only for deleted tasks when **Delete worktrees with deleted threads**
is enabled. It retains the whole group if any checkout has local files, an open terminal, or
another owner. Branches and checkpoint refs are retained. Failed preparations are also retained
for inspection; cleanup does not remove them automatically.

To free disk space manually, open **Settings > Worktrees > Local worktrees**. Select individual
worktrees or complete multi-repository groups within a project, then confirm cleanup. A group
is retained if any member has local changes, untracked files, a lock, or active work. Ignored
files, including `.env` and installed dependencies, require explicit confirmation and cannot
be recovered. Worktrees containing submodules are retained for manual Git cleanup.

Cleanup keeps branches, commits and thread history. Choose **Rebuild worktrees**, or continue a
thread, to recreate the directories. Reinstall dependencies and recreate any ignored files you
need. When connected remotely, cleanup runs on the machine named in the list.

## Worktree branch names

In **Settings → Worktrees → Branches**, **Remote branch display days** limits remote branch
lists by their latest commit time. The default is 21 days (3 weeks); set it to `0` for no age limit.
Local branches and the default branch stay visible. This only filters the list and never
deletes branches. Select a project to override its environment's value.

**Hide merged remote branches** is on by default and also filters branches whose commits are
already contained in `main` or `master`. It uses fetched remote refs, preferring `origin`, and
falls back to local branches when needed. Local branches and the base refs stay visible.
Turn it off to show those remote branches again, subject to the age limit. Squash merges that
do not retain the branch's commits are not detected by this Git ancestry check.

In **Settings → Worktrees → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named branches for new tasks and worktrees. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks on mobile

Open **Settings → Scheduled tasks** to create recurring tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's.

Deleting a thread also deletes tasks that post into that thread. Tasks that start
a new thread on each run survive deletion of their previous threads.

You can edit, pause, resume, run immediately, or delete a task from the list.
Webhook tasks only run when their URL is called, so they can't be run
immediately.
Leaving an edited form asks before discarding unsaved changes.

## Webhook automations

In **Settings → Scheduled tasks**, choose **On webhook**
as a task's schedule to run it whenever another service calls its URL, such as
GitHub on a new pull request or a CI job that failed. A public URL needs a
[T3 Connect](remote-access.md) managed tunnel; after you save the task, copy
its URL from the editor. Without one, the editor shows only the URL's path.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

Each value reaches the agent wrapped in `<webhook-data-…>` tags and marked as
untrusted request data. This helps the agent tell it apart from your
instructions, but it doesn't guarantee the agent ignores what the text says.
Inside a value, every `$`, other currency sign and `@`, and a `/` that starts
a lone word, gets an invisible character after it, so mentions like `$skill`,
`@file` and `/command` don't act. Text copied from a value, such as an email
address or a command, carries that character too. Without a signature, anyone
with the URL can start a run with any content. A signature only proves which
service sent the request: a GitHub payload still carries text written by any
GitHub user.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

To run only for some requests, add **Filters**. Each one tests a value named
like a placeholder, without the braces, such as `headers.x-github-event` equals
`pull_request` or `body.action` is one of `opened, reopened`. A task runs only
when every filter matches; other requests are answered normally, logged as
**Filtered** with the first filter that failed, and start nothing. Values
compare as text, and a value that is an object or a list only passes
**exists**. Separate **is one of** values with commas; a value can't contain
a comma or start or end with a space.

To suppress repeated deliveries, set a **Replay key** template, such as
`{{headers.delivery-id}}`. The same key is ignored for seven days per task.
To combine a burst, set a **Coalesce key**, such as `{{body.id}}`, and a window
of 10–3600 seconds (120 by default). One run uses the latest body, headers,
and query when the window from the first delivery closes; later requests
do not extend it. Pending windows survive a server restart. Keys must contain
request placeholders; if any placeholder is missing, or the render is empty,
that key's rule is skipped. Clear the templates to turn dedupe off.

Duplicate and coalesced log entries share a limit of 10 per task per minute.
Additional deliveries are accepted without a log entry, and coalesced deliveries
always replace the persisted payload. Coalesced updates count toward a separate
60-per-minute validation limit; exceeding it receives HTTP 429.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To have T3 Connect keep requests instead, turn on **Hold webhooks while
offline** in **Settings → Sharing & access**. T3 Connect then stores requests to a
T3 Connect URL for up to 24 hours and delivers them when the environment
returns. Leave it off if you don't want request bodies stored outside your
machine. To skip requests that waited too long, set **Skip requests older
than** on the task.

## Import and export settings

On web and desktop, open **Settings → General → Import and export** and choose
one connected environment. Export saves a JSON file containing this client's
preferences, theme library and selection, shortcuts, model preferences, shared
actions and portable environment defaults. On mobile, use **Settings → About →
Client Storage** and choose one environment with the filter. Native preferences
are restored on mobile; web and desktop preferences are restored on those clients.

For a project's explicit overrides and actions, select it in **Settings → Projects**
and use **Project configuration** for the checkout you want. Project imports replace that
checkout's explicit overrides; settings absent from the file inherit their defaults. This
also lets an earlier export restore inheritance. Application imports merge matching settings
and shortcuts, leaving other values intact. Project action shortcuts
remain environment-local. Repository-specific actions are matched by repository alias;
create the matching repositories before importing. Custom provider instances must already
exist on the destination with the same ID and driver.

Imports show their contents before saving. Export files exclude account credentials,
connection addresses, machine paths, browser profiles and conversation history. Application
exports include the selected environment's project and workspace definitions. Action
commands and custom instructions are included as written, so review them before sharing a file.
An import that fails after saving some settings reports incomplete progress; retry after
resolving the error. Export the destination first if you want a backup to restore.

To restore projects on another machine, choose that environment in **Settings → General**
(**About → Client Storage** on mobile), import an application or project export, and enable
**Clone repositories and create projects or workspace groups**. Optionally enter an absolute
directory or a `~/` path on that environment; the default is `~/projects`. Repositories are
deduplicated by Git identity and stored in stable repository folders inside that directory.
Projects and groups then point to those checkouts, including repository-relative subdirectories.
Repository setup actions are restored but are not run during import.

The server saves the import information before cloning. Saved imports show repository
results and **Retry failed import** continues after you fix network access, Git authentication,
directory permissions or provider configuration on that environment. Completed clones are reused,
including clones whose final move failed. Restarting the server pauses unfinished imports until
you retry them. Existing unrelated files and failed partial checkouts are retained. **Forget import**
removes only the saved import information. Clone URLs omit credentials; configure Git credentials
on the destination. Older exports without clone information can still copy settings into an
existing project; export them again from an updated server to create new projects.

Project configuration shows its Git repository and a versioned identifier. Standard SSH
and HTTPS remotes on GitHub, GitLab.com, Bitbucket.org and GitCafe share an identifier across
clones and worktrees.
The repository's own origin distinguishes forks, and repository-relative directories
distinguish projects inside a monorepo. Nonstandard ports and SSH user namespaces remain
distinct. Other hosts retain protocol, SSH path semantics and path casing. Renaming a remote repository or changing an SSH
host alias can change the identifier. Projects without complete Git metadata and multi-repository
groups use an environment-local identifier. Identifiers help compare exports; importing always
targets the checkout or destination environment you explicitly selected.

T3 Connect connects clients to environments. It does not back up app preferences to your
account. You can keep exported JSON files in a private Git repository or a synchronized
folder and import them on another device. Synchronize the exports rather than the live
T3 database or credential directories.

## Defaults and inheritance

Threads contains the model and workspace for new threads. Browser controls agent browser
access. Source control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

New tasks in **Current checkout** automatically create a development branch when the checkout
is on `main` or `master`. **New worktree** creates an isolated checkout instead. In
**Settings → Worktrees**, **Start from remote** also controls the base of these automatic local
branches: enabled uses the latest `origin/main` or `origin/master`, falling back to the local
branch when the remote branch is missing; disabled uses the local branch. Existing development
branches stay selected. If fetching or switching fails, the task stops before the agent starts.

The Projects category, under Code, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → Worktrees** under Advanced (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the T3 home directory. To put them somewhere else,
such as another drive, set **Settings → Worktrees → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Storage cleanup

Open **Settings → Worktrees → Cleanup** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
periodically. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's branches and worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after a thread settles, after
merging, or when they have no commits beyond the default branch. Set settled retention to 0 days
to remove a worktree at the next cleanup after settlement. These retention rules apply to T3-managed worktrees.
Active sessions and shared worktrees prevent removal. **Keep worktrees with local changes** defaults
to **Uncommitted changes**, which protects tracked edits and untracked files but deletes ignored
files such as `.env` and build output. **Any local files** also protects ignored files other than
`node_modules`. **Edited tracked files** protects only tracked edits and allows untracked and
ignored files to be deleted. Thread history stays; starting another turn recreates the checkout.
Branches are kept unless **Automatically delete merged branches and worktrees** is enabled.
That switch controls both merged-branch and merged-worktree cleanup. If it shows **Mixed** after an
upgrade, choose on or off to apply the same choice to both rules.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
