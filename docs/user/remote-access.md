# Remote access

Drive T3 Code from your phone, browser (`app.t3.codes`), or another desktop app while your agents run on a host computer or server. The host must stay awake and running while you work.

## T3 Connect (recommended)

T3 Connect links your host to your other devices without router port-forwarding.

- **Desktop host**: Open **Settings → Sharing & access**, sign in, and turn on **T3 Connect** (note: closing the desktop app's last window stops its local server—use the [background service](./background-service.md) for unattended access).
- **CLI / headless host**: Run `t3 up` (or `t3 connect` / `t3 up --connect --lan --yes` for non-interactive scripts) and complete the printed sign-in link on any device. Check status with `t3 status [--json]`.
- **Other devices**: Sign in to the same T3 Connect account and pick the environment.

### Approve new devices

By default, any device signed in to your T3 Connect account can open a linked
machine. To require approval instead, turn on **Require approval for new
devices** with the T3 Connect settings in **Settings → Sharing & access** on the
host, or when you first set up T3 Connect. Then someone who takes over your T3
Connect account cannot reach the machine from a new device without your
approval. Review the devices that are already approved, described below.

A new device waits and shows a code such as `K7QM-2XFD`. Approve it from a
device that is already connected, using the prompt or **Settings → Sharing &
access**. Check that the code matches the one on the waiting device. On a
headless host, run `t3 auth connect-device list` and then
`t3 auth connect-device approve K7QM-2XFD`. A request expires after 10 minutes,
and the device asks again when it retries. Deny keeps that device out until its
request expires.

Each device is approved once. Revoke it from **T3 Connect devices** in the same
settings page, or with `t3 auth connect-device revoke <code>`. With approval on,
it has to ask again. With approval off, it can connect again on its own, so
revoking in the app offers to turn approval on first. Devices that connected through T3 Connect while approval was off stay
approved and appear in that list for you to review. A device that has not
connected since you updated T3 Code asks for approval like a new one. Older apps
cannot show the code, so update them before you turn approval on.

### Use an end-to-end encrypted connection

In this fork’s Android app, select a T3 Connect environment to connect with
end-to-end encryption. The app retrieves and saves the host’s public key on
first use. If the connection shows a verification code, open **Settings →
Sharing & access** on the desktop host and approve only when the code matches.
The client reconnects automatically.

For official or older hosts that lack encrypted pairing, turn on **Allow T3
Connect without end-to-end encryption** under **Settings → Environments** on
Android. The tunnel still uses TLS, and its provider can read chat, file and
terminal traffic without end-to-end encryption.

If you treat T3 Connect as untrusted, turn on **Require approval for new
devices** on the host and review its approved devices. Otherwise a different
device on the account can still obtain ordinary access to this environment.
Use a trusted pairing link to verify the host key independently on first use.

On the host, run `t3 auth connect-device noise-pin`. Transfer the link directly to
your signed-in client through a trusted channel. In your own web build or desktop app,
open **Settings → Connections → Add environment** and paste the link into **Host**.
Use a web origin you trust to deliver the application code. In the Android app, open **Add
environment**, select **Use a trusted pairing link**, paste the link, and tap **Connect with
end-to-end encryption**. Compare the code in the environment’s connection status
with `t3 auth connect-device list` on the host. If they match, run
`t3 auth connect-device approve <code>`. The client reconnects automatically.
For later devices, you can also compare the code and approve the request on a
phone already connected to this environment through Noise with access management permission.
Open a thread to chat, attach files, open received attachments, or use its terminal as usual.
With file read access, open **Files** in the thread to preview a workspace file.
Use **Save to device** in the file menu to choose a folder for a full copy.
The host only sends files inside the selected workspace, including when a path
follows a symbolic link.

Voice input uses the same encrypted connection when you select an environment
in **Settings → Voice**. Selecting a cloud transcription provider lets the host
send the recording to that provider.

The host and phone encrypt chat history, attachment transfers, workspace file
paths and contents, and terminal input and output. T3 Connect can still observe
connection timing and traffic volume. Chat and pull request images load automatically.
External image hosts can see requests for public images. Supported private pull request media
loads through the environment using its source control credentials. In **Files**, open an HTML or
SVG file and choose **Preview** to view the rendered document through the encrypted connection.
In a web browser, use **Open file in preview browser** in the Files toolbar for an HTML page
that loads stylesheets, scripts, or images from the workspace.
If the host key changes, verify a fresh link directly on the host before choosing
**Use the new host key**.

For a dedicated host, set `T3CODE_NOISE_ONLY=true` in the server's environment
and restart it after linking T3 Connect and saving a trusted pairing link.
This applies to every network interface, including loopback. Connect an approved
client to use the host. Ordinary web sign-in, cookie-based guest URLs, direct WebSocket clients,
and plaintext webhook deliveries are refused. The host CLI can still approve or
revoke devices. To restore ordinary access, unset the variable and restart.
See [encrypted webhook delivery](./project-settings.md#encrypted-webhook-delivery)
for scheduled tasks on this host.

To deny a waiting request, run `t3 auth connect-device deny <code>`.
To disconnect an approved phone and require Noise approval again, run
`t3 auth connect-device revoke <code>`. On a connected Android phone you can also
open the environment in **Settings → Environments**, choose the matching code under
**T3 Connect devices**, and confirm **Revoke**.

### Link two hosts over Noise

Enable **Settings → Environments → Enable linked environments** on both hosts. Run
`t3 auth connect-device noise-pin` on each and exchange the environment IDs
and public keys through a channel you trust. Generate one shared token for
this pair with `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`.

Set `T3CODE_NOISE_PEERS_FILE` on each host to the path of a private JSON file.
Use its own Connect origin at the top level and the other host's origin, ID and
public key in `peers`. The public key identifies the destination, and the shared
token lets the destination authenticate its caller. The laptop’s file has this shape:

```json
{
  "origin": "https://laptop.example.com",
  "peers": [
    {
      "origin": "https://builder.example.com",
      "environmentId": "<builder environment ID>",
      "pin": "<builder public key from the pin field>",
      "token": "<shared token for this pair>"
    }
  ]
}
```

On the builder, swap the two origins and enter the laptop's ID and public key
with the same token. Restrict both files to the host account and restart both
hosts. Create an environment link in **Settings → Connections** at the configured
origin using a pairing code from the destination. Each link still has its own
access level. Removing a link revokes its session. Remove the peer entry and
restart to revoke the host's transport access. Generate a different shared
token for every pair of hosts.

A device connecting to that peer uses the destination's own device approval.
Automatic pairing of a third host requires its own matching peer configuration.
To use a direct LAN or Tailscale HTTPS address, add its origin to the
comma-separated `T3CODE_NOISE_PEER_ORIGINS` on the linking host and restart.
An environment with a configured Noise pin uses its pinned origin.

### Scripts and agents

`t3 up` asks nothing when you name a choice: `--connect`, `--lan`, or their
`--no-` forms. Choices you do not name keep their settings, and `--yes` takes
the defaults. Without a terminal:

- T3 Connect sign-in prints a URL and a code. Approve it on any device.
- A needed restart runs without asking, and stops running agent turns.
- With nothing set up and no choice named, `t3 up` stops and names the flags.

`t3 status --json` prints the settings. `t3 up --help` lists every flag with
examples.

### More machines with T3 Chat

Free T3 Connect accounts can link up to **3 host machines** (phones and browsers don't count). Link a paid T3 Chat account from your account menu → **T3 Chat → Link T3 Chat** to raise the limit to **10** (Pro) or **100** (Premier).

## Pair over a LAN or private network

- **Desktop host**: Enable **Settings → Sharing & access → Network access** (restarts desktop) and create a one-time pairing link.
- **CLI host**: Run `t3 up --lan` (background service) or `t3 serve --lan` (foreground), then run `t3 pair` to generate a QR code / pairing URL (`t3code://pair` opens directly in the desktop app).
- **Hosted web app (`app.t3.codes`)**: Requires an HTTPS endpoint (T3 Connect or Tailscale HTTPS). For plain HTTP on a LAN, open the direct pairing URL in a local browser or pair from the desktop/mobile app. For custom CAs on Android, install the CA certificate in Android security settings.
- **Session lifetime**: Paired devices stay signed in while active; sessions unused for 30 days must re-pair.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or T3 Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the T3 Connect list.
A pairing link for a saved machine is refused when it comes from an address
that machine does not have yet; add that address with **Add route** instead.
Pairing again over an address the machine already has still works. A new route
is placed by speed, in that order, and you can reorder routes at any time.

While connected through T3 Connect or a paired address, T3 Code also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through T3 Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned: **Network access** in the desktop app, or the
[local network](./background-service.md#local-network-access) choice in `t3 up`.
You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

T3 Code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, T3 Code checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works. A
route whose machine refused this device's sign-in is marked **Sign-in
refused**; pair that address again with **Add route** to use it.

On web and desktop, select the route count under the machine's name in
**Settings → Environments** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of T3 Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and T3 Connect have separate sessions and may grant
different permissions.

### Continue a thread on another machine

Open the thread's menu and choose **Continue on another machine**. Select a
project on another connected machine. You can attach the source thread's record, including tool
output, or leave it out and write a summary. Review the new draft and choose a model before sending.
The original thread stays where it is, and workspace files and live provider sessions do not transfer.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Environments → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet with [MagicDNS and HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) enabled. On Linux, grant [Tailscale operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission). In the desktop app, enable **Tailscale
HTTPS** in **Settings → Sharing & access**. Turn it off there to remove that route.
This uses Tailscale Serve: the HTTPS address is private to your tailnet and is
not accessible from the public internet.

- **Desktop**: Enable **Settings → Sharing & access → Tailscale HTTPS**.
- **CLI**: Run `t3 serve --tailscale-serve` or `t3 pair --tailscale` (use `--tailscale-serve-port` if 443 is taken; remove with `tailscale serve --https=443 --set-path=/ off`).

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 --set-path=/ off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Public access with Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) makes your server reachable
from the internet without installing Tailscale on the connecting device. It
requires Tailscale on the host, MagicDNS, HTTPS certificates, and Funnel permission
in your tailnet policy. Follow Tailscale's setup prompts to enable these.

With T3 Code running on the host:

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:3773
```

Replace `3773` with your server's actual port. Use `8443` to keep Funnel separate
from the desktop app's default Tailscale HTTPS port, `443`. Configuring Serve on
the same port as Funnel makes that port private again.

Use the public HTTPS address printed by Funnel, including `:8443`. On the host,
create a pairing link in **Settings → Sharing & access** and copy its pairing
code. On mobile, open **Add environment**, enter the Funnel address and that code,
then connect. For a command-line host, create a link using the public address:

```bash
t3 auth pairing create --base-url https://machine.tailnet.ts.net:8443
```

Replace the example hostname with the one Funnel prints. The host must stay
running. The `--bg` mapping persists across restarts; remove it with:

```bash
tailscale funnel --https=8443 off
```

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS. Opening a hosted pairing link shows the
server address and asks you to confirm before adding it.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Environments → Add environment → SSH** and enter a host or SSH alias (e.g. `user@example.com`). T3 Code downloads its runtime to `~/.t3/runtime` on the Linux or Apple Silicon macOS host, starts or reuses a server, and manages port forwarding automatically.

For password authentication, choose **Enter password manually**. The password
is used for that connection attempt and is not saved. For a Cloud Sandbox you
connect to repeatedly, save its host and SSH password under **Settings → Meituan
integration → Cloud Sandbox**. The desktop app uses that password only when the
resolved host and port match. The SSH host key must already be trusted. If the
saved password is rejected, update it in settings or enter a password manually.
Before rolling back to a desktop version that supports only one Cloud Sandbox,
keep just the server you want to use and save it in the current version. The
single-server version cannot read a list of credentials. Versions with multi-server
support can read and edit all saved servers.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

T3 Code cannot answer a second sign-in prompt such as a Duo code. On macOS and
Linux it can reuse a connection you signed in to in a terminal instead: turn on
connection sharing for the host in `~/.ssh/config`, run `ssh <alias>`, then
connect. When that connection closes, sign in again in a terminal and retry.

```sshconfig
Host <alias>
  ControlMaster auto
  ControlPath ~/.ssh/cm-%C
  ControlPersist 8h
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Sharing & access** on the host, or on a headless host with `t3 auth session list` and
`t3 auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Browser on a remote environment

Browser tabs belong to the host environment so you and your agents share them from any device.

- **Streaming & local loading**: Web and mobile stream tabs from the host. In the desktop app, tabs you open for a remote environment load locally while routing `localhost` requests to the host over the **preview tunnel** (so element picker and annotations work locally).
- **Port forwarding (desktop)**: Forward any remote host port to your local `localhost` via the thread's **Servers** list or **Forwarded ports** in the command palette (`Cmd/Ctrl-click` forwards and opens in your browser).
- **Open on this device (mobile)**: Tap **Open on this device** on a streamed `localhost` tab or long-press a `localhost` link in chat for native touch scrolling.
- **Disable preview tunnel**: Turn off **Settings → Sharing & access → Preview tunnel** on the host (or via [managed policy](./managed-policy.md#other-capabilities)) to disable port forwarding and **Open on this device** (streamed tabs continue working).
- **Take control**: Click **Take control** before typing into an agent's tab, and release control when done.
- **Local servers**: T3 Code lists listening ports from your terminals and agents as `http://localhost:<port>` (set a script's **Preview URL** for HTTPS or subpaths). Disable discovery with `T3CODE_PORT_DISCOVERY=0`.

### Browser host setup

The first server browser tab downloads ~120 MB headless Chromium (shared with [HTML renders](./html-renders.md)). On Ubuntu 23.10+ or minimal Linux containers, run the one-time setup command on the host:

```sh
sudo t3 browser setup
```

This installs an AppArmor profile for Chrome's sandbox plus missing libraries and fonts. Never run the T3 server as root (Chrome's sandbox rejects root); if sandboxing is impossible on your host, set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the server environment and restart.

## Link another environment

Link two T3 Code machines (beta) so agents on one can launch, message, delegate to, and manage threads on the other.

Linked environments is enabled by default. Manage it for both machines in **Settings →
Environments**. On mobile, open each machine's details from that page. On a headless
server, open its address in a browser and pair to reach the same settings page, or add `"linkedEnvironmentsEnabled": true` to `settings.json` in its
`userdata` directory, such as `~/.t3/userdata/settings.json`; a running server
picks it up. While it is
off on either machine, agents start nothing over a link between them. A task
already running on the other machine still finishes, and if that machine has it
off, its result arrives once it is back on.

- **Access boundary**: Agents never get more permissions on the target than the link's access level or their own thread mode. Below Full access, linked agents can only modify threads they started and skip project setup scripts.
- **Delegation**: Agents can target a linked machine with `delegate_task`, or ask you to link an unlinked machine via an in-thread approval card.

### Read a linked machine's threads

Open a delegated task or thread link on a linked machine to follow it live (read-only) in the right panel without pairing your client directly. Click **Connect to interact** to pair and take action (one-click if the link has Full access and you can manage access). Files, images, and HTML renders stay on the remote machine until you connect directly.

## Manage or revoke access

Manage pairing links and active client sessions in **Settings → Sharing & access** or via `t3 auth --help`.

- **Scoped tokens**: Pass `--scope <scope>` (repeatable) to `t3 pair`, `t3 auth pairing create`, or `t3 auth session issue` to restrict permissions (e.g. `orchestration:read`, `source-control:write`, `filesystem:read`, `filesystem:write`, `terminal:operate`, `relay:configure`). Re-pair with a fresh link to change an existing client's scopes.
- **Deregister from T3 Connect**: Open your account menu → **T3 Connect → Deregister** (or `t3 connect unlink` / `t3 connect logout` on CLI hosts). Idle tunnels are automatically cleaned up after 5–10 minutes offline and recreated on reconnect (hosts on older versions offline for 7+ days need an update first).
- Treat pairing URLs and codes as passwords—never paste them into logs or screenshots.

## Desktop app as a remote only

Switch off **Settings → Environments → Local environment** in the desktop app to run with no local server or incoming connections while continuing to drive remote hosts (if a local background service uses the same T3 home, **Open in** still works locally).

## Troubleshooting

See [T3 Connect troubleshooting](./t3-connect-troubleshooting.md) for step-by-step connection diagnostics, and [Outside agents](./outside-agents.md) for MCP connections.
