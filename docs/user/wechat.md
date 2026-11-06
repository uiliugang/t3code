# WeChat

Use **Settings → Communication → WeChat** to connect your account on the environment that runs your tasks. Scan the pairing code, confirm in WeChat, and enter the verification code if requested. Send the bot a first message to activate the connection, then select the target thread in T3 Code.

If T3 shows a `/bind` code after pairing, send that exact command to the bot within ten minutes to verify your identity.

Only the paired WeChat user can send tasks. Text messages continue the selected thread using its current permissions; new tasks queue while it is busy. `/status` shows its status, `/stop` requests a stop and holds its queue, and `/help` lists the commands. Handle approvals and questions in T3 Code. This connection supports direct messages and text replies.

Enable **Push task results** to receive completion, failure, and waiting-for-input notifications. To include scheduled tasks that create new threads, enable **Include all threads and scheduled tasks in this project**. Messages and results pass through WeChat, so choose a project whose results you want to share there.

Keep the environment running for continuous delivery. Queued results and the reply context survive server restarts; delivery errors appear in recent deliveries. If a delivery is unconfirmed, check WeChat before retrying because it may already have arrived. Expired authorization requires pairing again.

**Pause WeChat** stops receiving and sending. Resuming skips messages from before the resume time. **Unlink** removes local credentials and queued deliveries without stopping existing T3 tasks. You may also need to remove the authorization in WeChat.
