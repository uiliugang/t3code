# Install T3 Code

T3 Code runs coding agents on your computer (or server) and lets you control them from the desktop app, web app, or mobile app. Install T3 Code on the machine where your agents will run first.

## Requirements

You need at least one installed, authenticated coding agent (provider) before starting a thread. You can launch T3 Code first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

## Command line

Install the fork's CLI on an Apple Silicon Mac or on x64/arm64 Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/uiliugang/t3code/main/scripts/install.sh | sh
```

This installs the `t3` command to `~/.local/bin`. If that folder is not on your
`PATH` yet, the installer says so and, for zsh, bash on Linux, and fish, prints
a command to add it. If a `t3` that the installer or the desktop app did not
create is already there, it leaves that one alone and stops. Set `T3CODE_VERSION`
to pin an exact published version. The fork's release workflow publishes stable
builds only.

| Task                          | Command                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| Start server and open web app | `t3` (or `t3 ./my-project`)                                             |
| Start server without browser  | `t3 serve`                                                              |
| Set up remote access          | `t3 up` ([Remote access](./remote-access.md))                           |
| Run in the background         | `t3 service install` ([Background service](./background-service.md))    |
| Update                        | `t3 update`                                                             |
| Reclaim database space        | `t3 doctor` ([Details](./background-service.md#reclaim-database-space)) |
| Uninstall                     | `t3 uninstall`                                                          |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, run the `t3 pair`
command it names and open the pairing URL to connect to that server. Stop it
before starting a replacement, or use a different `--base-dir` for an
independent server.

These scripts install the uiliugang fork. `npx t3@latest` and the package managers
listed below distribute the upstream version, which does not include this fork's additions.

To try upstream T3 Code once without installing it, run `npx t3@latest` instead (needs
Node.js for `npx`). It offers to install the `t3` command first. If you say no,
it asks again at the next minor release, and `npx t3 install` installs it later.
`npx t3` always runs the version npm picked, even when the fork's `t3` is installed.
To use the fork, run the installed `t3` instead (for example `t3 connect`).

### Intel Macs

The fork does not publish Intel Mac binaries. To run a server there, build it
from source with `vp`, which provides the Node version it needs
([Install vp](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/uiliugang/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

## Desktop app

Download the fork's Apple Silicon DMG or Linux AppImage/DEB
from [the fork's GitHub Releases](https://github.com/uiliugang/t3code/releases).
For upstream macOS and Linux builds, including Intel Macs, use
[upstream GitHub Releases](https://github.com/pingdotgg/t3code/releases) or a package manager:

| Platform                | Command                                                      |
| ----------------------- | ------------------------------------------------------------ |
| macOS                   | `brew install --cask t3-code`                                |
| Debian / Ubuntu         | `sudo apt install ./T3-Code-*.deb`                           |
| Arch Linux              | `yay -S t3code-bin` (or `yay -S t3code-nightly-bin`)         |
| Nix (flakes, Nix 2.30+) | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code` |

### Install or update with curl

On an Apple Silicon Mac or x86_64/ARM64 Linux, quit T3 Code and run this command
to install or update the fork's desktop app:

```bash
curl -fsSL https://raw.githubusercontent.com/uiliugang/t3code/main/scripts/install-desktop.sh | sh
```

The script detects the OS and CPU architecture, downloads the latest stable
release, and verifies it against the release's `SHA256SUMS` before replacing the
app. It installs a DMG on macOS or an AppImage on Linux, without changing your T3
home, threads, provider accounts, or projects. It does not launch the app
afterwards. Repeat the command to update.

To install a specific release without looking up the latest version:

```bash
curl -fsSL https://raw.githubusercontent.com/uiliugang/t3code/main/scripts/install-desktop.sh | T3CODE_VERSION=0.0.17 sh
```

The default installation directory is `/Applications` on macOS and
`~/Applications` on Linux. Set `T3CODE_DESKTOP_INSTALL_DIR` on the `sh` command to
use another absolute path. For example, a Mac without write access to
`/Applications` can use `T3CODE_DESKTOP_INSTALL_DIR="$HOME/Applications"`.
To download from a trusted mirror, set `T3CODE_RELEASE_BASE_URL` to its
`releases/download` root. A mirror-only installation also needs `T3CODE_VERSION`
to avoid the GitHub version lookup.

The script installs the desktop app only; use the separate
[CLI installer](#command-line) for a standalone server.

### macOS

The curl installer checks the app's minimum macOS version and bundle signature
before replacing an existing installation. It does not enable in-app automatic
updates. These builds use ad hoc signing, not Apple notarization. The installer does not
remove quarantine attributes or change Gatekeeper settings. If macOS blocks the
app, follow [the fork's macOS instructions](../../README.md#macos-提示无法验证应用).

### Linux

The [curl installer](#install-or-update-with-curl) automatically downloads
`T3-Code-x86_64.AppImage` or `T3-Code-arm64.AppImage`, makes it executable, and
installs it in `~/Applications`. Open that file to start T3 Code. It needs `curl`,
`pgrep` (from procps/procps-ng), and `sha256sum` or `shasum`, along with the app's
normal Linux desktop libraries. It does not install OS dependencies or use `sudo`.

Keep `.t3-desktop-source` in the installation directory: it identifies files the
script may update. An existing unmanaged AppImage or symbolic link is left alone;
move it aside before installing there. DEB and package-manager installations stay
separate and are not updated by this script.

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`T3-Code.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./T3-Code.AppImage
./T3-Code.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

The AUR packages support x86_64 and ARM64.
Update AUR installs with your AUR helper, such as `yay -Syu`, instead of the
in-app updater.

### Nix (nixpkgs)

T3 Code is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code).
The command above installs from `nixos-unstable` and requires Nix 2.30 or later with
`nix-command` and `flakes` enabled. Launch the desktop app with `t3code-desktop`;
the package also includes the `t3` command.

On NixOS, you can instead add the package to your system configuration, using
a nixpkgs revision that includes `t3code`:

```nix
environment.systemPackages = [ pkgs.t3code ];
```

Apply the change with `sudo nixos-rebuild switch`. For Home Manager, add
`pkgs.t3code` to `home.packages` and run `home-manager switch`.

Update a profile installation with `nix profile upgrade t3code`. For NixOS or
Home Manager, update your configuration's nixpkgs input or channel and rebuild.
Nix manages both the desktop app and the bundled
`t3` command; use Nix to update them instead of the in-app updater or `t3 update`.

### The `t3` command

The desktop app bundles `t3` and sets it up on first launch (manage anytime under **Settings → About → t3 command**). Use **Add to PATH** if needed, then open a new terminal.

- **Open a folder in the running desktop app**: Run `t3 app` (or `t3 app ../my-project`) from a terminal, or drag folders from your file manager onto the desktop sidebar.

## Access from Windows

The fork does not support a native Windows desktop app, server, or CLI, and the
desktop app does not manage WSL environments. To use T3 Code from Windows, open
the [web app](https://app.t3.codes) and connect to a host running T3 Code.

You can also install the [Linux CLI](#command-line) and your provider CLIs
inside a WSL distribution. Start the server in that distribution and connect
to it as a [normal remote environment](./remote-access.md), not as a
desktop-managed backend. Keep any existing projects and T3 data in the
distribution until you have verified your new connection.

## Mobile app

Get the fork's Android arm64 APK from [the fork's GitHub Releases](https://github.com/uiliugang/t3code/releases).
The upstream app is available for iPhone and iPad from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) and for Android from [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code) (QR codes are also in **Settings → About → Mobile app**). The mobile app connects to a server on another machine via [remote access](./remote-access.md).

- Store builds work with both Stable and Nightly servers. Optional Android beta APKs are under [Android beta releases](https://github.com/pingdotgg/t3code/releases?q=android-beta-).
- If the mobile app crashes on launch, open **Settings → Diagnostics** on the next launch to copy recent startup crash reports.

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

To remove a provider, select it in **Settings → Providers** and choose **Remove**.
T3 Code stops its active sessions and clears its saved settings and unused managed
resources. Shared managed resources stay until their last provider is removed.
Personal CLI installations and configuration stay in place. Account folders outside
the environment's data directory also stay, since other environments may use them.
You can add the provider again later.

| Provider            | Install and authenticate                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex               | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude              | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor              | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build          | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro                | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode            | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity         | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi                  | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code           | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx                  | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |
| ACP Registry agents | Add GitHub Copilot and other [ACP agents](./providers-acp.md#add-an-agent) from **Settings → Providers → Add provider → Show more**.                      |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during T3 Code's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro         | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code    | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how T3 Code works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating T3 Code](./updating.md): keep apps, servers, and providers up to date.
