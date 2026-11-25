# Guest links

A guest link lets a teammate follow one thread in their browser and ask the agent questions, with no
account. They see your messages and the agent's replies as they stream. Each message they send waits
until you send or dismiss it.

## Share a thread

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

1. Right-click the thread in the sidebar and choose **Share with guest**. It is also in the thread
   menu and the command palette. In the mobile app, long-press the thread in the list.
2. Copy the link and send it to one person. It works in one browser and expires after 24 hours.
   Opening it again in that browser takes them back to the thread.
3. When they send a message, it appears at the end of the thread and the sidebar shows **Request**.
   Choose **Send** to run it as a normal turn, or **Dismiss**. Files they attached show with the
   message, and **Send** includes them.

Choose **Stop sharing** to end the link at once. Archiving the thread, creating a new link, or
removing the origin serving the link also ends it. The mobile app can send, dismiss, and stop
sharing too.

## What the guest sees

The guest sees the thread's recent history and everything after, in the same timeline you see, as
it streams: messages and their files, the agent's replies with the images they show from your
machine, its reasoning, plans, questions, and its work, with command output when they expand a
command. Their composer shows the thread's model, but they cannot change it. They do not see diffs, and they cannot act on the thread: no forking,
reverting, opening files on your machine, or answering the agent for you.

Anything the agent read or printed can show, such as a value from a file. Share only threads you
are comfortable showing.

## Guest attachments

Guests can attach images and other files to a message: use the paperclip, paste, or drop them on
the message box. A message holds up to 4 files and 10 MB in total. Images must be PNG, JPEG, GIF, or
WebP. While messages wait for you, their files can total 20 MB; the guest can attach more once you
send or dismiss some.

Dismissing a message, ending the link, or archiving the thread deletes the files of messages that
still wait. A sent message keeps its files, like any message in the thread.

The guest's text and files run with the thread's current permission mode once you send them. Check
them before you choose **Send**, as you would anything pasted from a chat.
