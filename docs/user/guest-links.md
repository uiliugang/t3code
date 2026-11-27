# Guest links

Share a single thread with a teammate in their browser—no account required. Guests see messages and agent activity stream live, and any message they send waits for your approval before running.

## Prerequisites and sharing

Guest links are a beta. Turn on **Settings → Labs → Guest links** for the machine that runs the
thread. A regular guest link uses the machine's T3 Connect address. The machine must stay online
while the guest uses it.

For encrypted links, serve the fork's web client from an HTTPS origin you control and set
`T3CODE_NOISE_GUEST_APP_ORIGIN` on the host to that origin. Restart the host. The guest opens
the fork's `/guest` page, which connects to the host through its active T3 Connect tunnel. To
use another publicly reachable HTTPS endpoint that forwards WebSocket upgrades, set
`T3CODE_NOISE_GUEST_RELAY_ORIGIN`. The app and relay must have different origins. Send the
entire generated link privately, including the fragment containing the host key and invitation.
The trusted page redeems it over Noise and keeps its thread-scoped session in that browser tab.
These links also work with `T3CODE_NOISE_ONLY=true`.

On a host that accepts regular HTTPS guest sessions, you can instead set
`T3CODE_NOISE_GUEST_ORIGIN` to a private HTTPS origin serving the host directly, for example
`https://workstation.example.ts.net`. The guest must trust its certificate and reach it over
your LAN or tailnet.

While the setting is off, every guest link on that machine stops working; links that have not
expired work again when you turn it back on.

1. Open the thread's menu (or command palette / mobile long-press) and choose **Share with guest**.
2. Send the copied link to one person (works in one browser and expires after 24 hours).
3. Guest messages appear at the end of the thread (**Request** in the sidebar). Choose **Send** to run as a normal turn (in the thread's current permission mode—review text and files first) or **Dismiss**.

Choose **Stop sharing** to end the link at once. Archiving the thread, creating a new link, or
removing the origin serving the link (including unlinking T3 Connect for a tunnel-backed link) also ends it. The mobile app can send, dismiss, and stop
sharing too.

## What guests can see and attach

- **Visible**: Thread messages, files, agent replies, images, reasoning, plans, questions, and command output. Anything the agent printed is visible—only share threads you're comfortable exposing.
- **Restricted**: No diffs, file browser, model switching, forking, reverting, or answering approvals/questions.
- **Attachments**: Up to 4 files (10 MB total) per message (PNG, JPEG, GIF, WebP images + other files), up to 20 MB total across pending unapproved messages. Dismissing or ending the link deletes pending files.
