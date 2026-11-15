# Log drains

A log drain forwards container logs from a server's agent to an external system. Drains can be **server-wide**
(every Tugra container on a server, optionally narrowed by name patterns) or **per app** (only that app's
containers). Logs go from the agent straight to your sink: they never pass through the hub.

## Targets

| Type | Wire format | Endpoint | Auth |
| --- | --- | --- | --- |
| `http` | Tugra batch JSON (`{"server", "lines": [{"container", "message"}]}`) | `https://...` URL | optional Bearer token |
| `loki` | Grafana Loki push API | Loki push URL | optional Bearer token |
| `datadog` | Datadog logs intake | intake URL | API key sent as `DD-API-KEY` |
| `syslog` | RFC 5424 over UDP, TCP or TLS | `host:port` | none |
| `gelf` | GELF 1.1 JSON over UDP, TCP or TLS | `host:port` | none |
| `fluentd` | fluentd Forward protocol (MessagePack) over TCP or TLS | `host:port` | optional shared key |

The `host:port` endpoint accepts a host name, an IPv4 address or `[IPv6]:port`; no scheme and no path.

### Options per transport

Options are validated strictly (unknown keys are refused: a secret never belongs in `options`).

- **syslog**: `proto` (`udp`, `tcp`, `tls`, required), `facility` (0-23, default 16), `framing` (`octet` or
  `newline`, tcp/tls only; default octet for tls, newline for tcp), `appName` (letters, digits, `.` `_` `-`).
  Each record is `<PRI>1 TIMESTAMP HOST APP - MSGID - MESSAGE`: PRI is facility x 8 + severity (stderr is 3,
  everything else 6), MSGID is `stdout` or `stderr`, the host is the server name. Control characters in a message
  are replaced by spaces so one line is always one record. UDP sends one datagram per line, capped at 1400 bytes
  (longer messages are truncated); TCP/TLS cap a record at 64 KiB.
- **gelf**: `proto` (required), `compress` (`none`, `gzip`, `zlib`; UDP only, default `gzip`). A UDP message
  larger than 1420 bytes is split into GELF chunks (at most 128). TCP and TLS send NUL-terminated, uncompressed
  messages. Fields: `version`, `host`, `short_message`, `timestamp`, `level`, `_container`, `_stream`, `_source`
  and, for an app drain, `_app_id`.
- **fluentd**: `proto` (`tcp` or `tls`, required), `tag` (default `tugra`; the container name is appended), and
  `requireAck` (default on). With acknowledgements on, each chunk is retried until the server answers
  `{"ack": ...}`, so a chunk can be delivered twice. A **shared key** (stored like any drain token, never in
  `options`) turns on the HELO/PING/PONG handshake, which authenticates both sides; the agent refuses a server
  that does not prove the key.
- **TLS** (`proto: tls`): the certificate is always verified (TLS 1.2 or newer; there is no insecure option).
  `serverName` overrides the name used for verification, and `caCert` adds up to four PEM certificates to the
  system trust store for that drain.

## Scope and filtering

- A **server-wide** drain is configured on the server's **Log drains** tab. Its optional container filter is a list
  of name patterns (`*` and `?`), for example `tugra_db_*`. Empty means every Tugra container on the server, as
  before.
- A **per-app** drain is configured on the app's **Logs** tab. It ships that app's containers only: the app's
  container, its rolling-deploy twin, compose services (`tugra_<id>-<service>-<n>`) and swarm tasks. Other apps and
  databases on the same server never reach it. For a compose app that is not deployed to a swarm you can narrow it
  to named services (a service named `web` does not match `web-2`). A swarm app's drains reach every member server
  of its cluster.
- An app's logs reach both a server-wide drain and the app's own drains.
- The hub resolves which containers belong to an app and sends the agent a fixed selector; no user-supplied
  pattern ever reaches an app-scoped filter.

## Egress policy

Drains run from the host, so where they may connect is restricted.

- Cloud metadata and link-local addresses (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`), the unspecified
  address and multicast are **never** allowed, for any drain. The agent checks the address the name actually
  resolves to when it connects, so a DNS name or an HTTP redirect cannot reach them.
- A **per-app** drain additionally cannot reach loopback, private (RFC 1918), `100.64.0.0/10` and unique-local
  addresses unless **Allow private network targets** (`allowPrivate`) is set. Setting it, or changing the
  destination of a drain that has it, needs the `servers:ops` permission on the team that owns the app's server, on
  top of `apps:config`. Server-wide http/loki/datadog drains keep their previous reach.
- App drains need `apps:config` on the app's team. The server's operators see which app drains ship from their
  server (name, type, app, delivery) but never the endpoint, options or token.

## Delivery status

Each drain shows a delivery state: **Delivering**, **Waiting for first delivery**, **Agent offline**,
**Agent update required**, **Logs capability revoked**, **Disabled**, **Delivery failing** (with a failure class
such as DNS, connect, TLS, timeout, refused, HTTP error, write, acknowledgement or egress policy) or **Invalid
configuration**. The agent reports lines sent and dropped every 30 seconds and on change; the hub keeps this in
memory (it resets when the hub restarts). No error text, endpoint or token crosses the wire, only the class.

## What to expect (guarantees)

- Delivery is **best-effort and at-least-once**. There is no persistence: lines emitted while the agent is
  disconnected from the hub are lost, because the forwarder lives with the agent's connection. After a tail restarts
  (a container that restarted quickly) the boundary line can be delivered twice.
- Every sink has its own bounded queue. A slow or dead sink drops its oldest batches (counted) and never delays
  the container tails or another sink; after three failed batches it backs off for a growing interval (up to a
  minute) and drops batches meanwhile.
- **UDP cannot confirm delivery.** Prefer TCP or TLS when losing lines matters.
- A line longer than 1 MiB is truncated (with a marker) instead of stopping the tail.
- Containers started with a `--log-driver` that `docker logs` cannot read (set through custom Docker options) are
  silently not forwarded.
- Preview deployments do not inherit drains, and cloning an app, the importers and config snapshots never copy
  drains: a drain is runtime egress that can carry a credential, not deploy configuration.

## Upgrade order and old agents

Upgrade the hub first. A hub pushes drains in a **signed** `log_drains_v2` frame, gated on the server's `logs`
capability (revoking `logs` now stops drain egress; `logs` is granted by default). An agent without the
`log_drains_v2` feature only receives plain server-wide http/loki/datadog drains, exactly as before; anything
else (per-app drains, a container filter, syslog/GELF/fluentd) is withheld and shows **Agent update required**.
An agent newer than its hub keeps working with the legacy frame.

## API

- Server-wide: `GET/POST /servers/{id}/log-drains`, `PUT/DELETE /servers/{id}/log-drains/{drainId}`
  (needs `servers:ops`; the drain must belong to that server).
- App drains: `GET/POST /apps/{id}/log-drains`, `PUT/DELETE /apps/{id}/log-drains/{drainId}` (needs `apps:config`;
  reading needs the `read:secrets` scope for a token).
- Summary for server operators: `GET /servers/{id}/log-drains/apps`.

Limits: at most 10 drains per app and 32 app drains per server.
