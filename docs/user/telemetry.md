# Diagnostics and data sharing

This fork does not send product usage events, T3 Connect client traces, or mobile crash and startup reports. On mobile, startup crash records can still be reviewed and copied locally.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a fork host, it sends a signed wake signal
identifying the environment. T3 Connect and Firebase can see the recipient, environment ID
and delivery timing. An approved Android phone reads project and thread titles, activity
status and other notification details from the host over its encrypted connection.
See [mobile notifications](./mobile-notifications.md).

To stop sending wake signals, turn off **Publish agent activity** under **Settings > Sharing & access**
on the host. Notification preferences on each phone control what it displays.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
