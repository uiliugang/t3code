# T3 Connect troubleshooting

A T3 Connect connection passes through four stages:

1. **This device** reaches T3 Connect over the internet.
2. **T3 Connect** verifies your sign-in and host link.
3. **The host's tunnel** (`cloudflared`) forwards the request to the host.
4. **T3 Code on the host** answers.

When a connection fails, open **Settings > Environments**, find the environment,
and select **Details**. A failed part points to the relevant section below.
When a gateway error leaves the tunnel and host unchecked, follow the
retry advice and **More info** link in Details.

To see the host's side, run `t3 connect status` on the host, or open
**Settings > Sharing & access** on the host. Both check the host's T3 Connect
address from the host, and say why it fails. `t3 connect` runs the same check
when it finishes setup. This check cannot test another device's network. For a
problem on one device, use **Details** on that device.

## The host's tunnel is offline

T3 Connect could not reach the host's tunnel (host is asleep/offline, T3 Code isn't running, or outbound port 7844 is blocked).

1. Confirm the host is awake and running T3 Code.
2. Run `t3 connect status` on the host.
3. If the host was offline for 7+ days on an older version, start and update T3 Code on the host to recreate its tunnel.

## Port 7844 is blocked on the host

`cloudflared` connects outbound to Cloudflare on **TCP and UDP port 7844** (normal web traffic still works when 7844 is blocked).

- **Tailscale exit node**: Run `tailscale set --exit-node=` on the host or allow outbound 7844 on the exit node.
- **Work VPN / firewall**: Allow outbound TCP/UDP 7844, or bypass T3 Connect by adding a direct Tailscale route ([Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways)).

## The tunnel works, but T3 Code does not answer

If the public address returns HTTP 502 and the configured local port does not
accept a connection, check these causes:

Restart T3 Code on the host (`t3 service restart` for a background service) and run `t3 connect status`.

## The T3 Connect address does not resolve or answer

The host's T3 Connect address failed DNS, TLS, connection, or timed out.

1. Confirm the host is online and run `t3 connect status`.
2. If only the host fails, check DNS/VPN/proxy (stale DNS caches clear in ~30 minutes).
3. If the address no longer points to this host, re-link it: toggle **T3 Connect** off and on in **Settings → Sharing & access**, or run `t3 connect link` and restart the server.

## This device can't reach T3 Connect

The issue is on the client device's network:

1. Check for captive portals or dead Wi-Fi.
2. Temporarily disable VPNs, firewalls, ad blockers, or DNS filters (on iPhone, test turning off Wi-Fi **Connectivity Assist**).
3. Try another network or add a direct Tailscale route ([Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways)).

## Sign-in, account, or link problems

- **Different account**: Sign in to the same T3 Connect account on both sides (on host: `t3 connect logout && t3 connect`).
- **T3 Connect disabled on host**: Turn on **Settings → Sharing & access → T3 Connect** or run `t3 connect`.
- **Link not yet applied**: Restart T3 Code on the host (`t3 service restart` or restart desktop app).
- **Expired session**: Sign out of T3 Connect and sign back in.
- **Waiting for device approval**: Approve the displayed code from an existing device or run `t3 auth connect-device approve <code>` on the host ([Approve new devices](./remote-access.md#approve-new-devices)).
- **Machine limit reached**: Deregister an unused host or [link a paid T3 Chat account](./remote-access.md#more-machines-with-t3-chat), then restart the host.

## The clock is off

T3 Connect uses short-lived signed proofs. Enable automatic date and time on both the host and client device, then retry.

## The host runs an older T3 Code

Update T3 Code on the host machine ([Updating T3 Code](./updating.md)).

## T3 Connect returned an error

An HTTP 502 can occur after T3 Code has answered a request, if the tunnel loses
its connection before delivering the response. Retry shortly. If it keeps
happening, check the host's `relay-client.ndjson` for edge connection errors.

| Error                                                     | Fix                                                                                                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Remove an unused environment or link a paid T3 Chat account, then restart T3 Code on the host.                                                                                                       |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in.                                                          |
| Expired or invalid link proof                             | Check the host's date and time, update T3 Code, then restart it.                                                                                                                                     |
| HTTP 403 without a recognized error                       | If the host requires approval for new devices, update T3 Code on this device and approve it. Otherwise check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report. |
| HTTP 408, 429, or 5xx                                     | Wait a few minutes. T3 Code retries temporary failures on its own.                                                                                                                                   |

After fixing a permanent error, restart the host (`t3 service restart` or restart `t3 serve`). If T3 Code stops when SSH disconnects, see [background-service troubleshooting](./background-service.md#troubleshooting).

## Report a problem

Open an issue on [GitHub](https://github.com/pingdotgg/t3code/issues) with:

- **Copy diagnostics** from the environment's **Details**
- Output of `t3 connect status` on the host
- Trace ID (if shown)
- `~/.t3/userdata/logs/relay-client.ndjson` (tunnel tokens are already stripped)
