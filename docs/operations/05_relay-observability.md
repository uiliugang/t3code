# Relay observability

The relay Alchemy stack (`infra/relay`) provisions a stage-scoped Worker trace dataset (`t3-code-relay-traces-<stage>`), a scoped write-only ingest token, and the `t3-code-relay-health` dashboard.

Prefer Axiom dashboards and APL queries over tailing the Cloudflare Worker. Scripted queries use account-level `AXIOM_TOKEN` + `AXIOM_ORG_ID` (runtime ingest tokens are write-only). Effect HTTP attributes live under `attributes.http.*`, and relay custom annotations live under `attributes.custom`.

## Alerts

Threshold monitors in [`infra/relay/src/monitoring.ts`](../../infra/relay/src/monitoring.ts) activate when `RELAY_ALERT_NOTIFIER_ID` is set (optional warnings go to `RELAY_WARNING_NOTIFIER_ID`). Monitors count HTTP status codes, not span errors—a 9 s relay timeout returns 504 even without a span error flag, and `/connect` 502s are normal for offline hosts.

- **Links / tunnel recovery failing / Cloudflare 429s:** Check "Link failures by reason" and Cloudflare API status on `t3-code-relay-health`. Sustained 429s indicate Cloudflare API rate limiting or a recovery loop; slow Postgres points at DB/Hyperdrive.
- **Environments unreachable:** Check Cloudflare Tunnel status and recent relay deploys before blaming hosts.
- **Push delivery failing:** Inspect `relay.apns_deliveries.process_signed_job` or `relay.fcm.process` errors—an expired APNs key or FCM service account fails every job.
- **Traffic dropped:** Check `https://relay.t3.codes/health` first.
- **Tunnel cleanup stopped / deletions failing:** Check `relay.managed_endpoint_reaper.sweep` spans and Cloudflare API errors. To pause cleanup during an incident, set `RELAY_TUNNEL_CLEANUP_MODE=off` and redeploy the relay (see [Managed tunnel cleanup rollout](./03_release.md#managed-tunnel-cleanup-rollout)).
