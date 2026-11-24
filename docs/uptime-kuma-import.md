# Importing from Uptime Kuma

Uptime > **Import from Uptime Kuma** brings your Kuma monitors and their alert links into Tugra. It is a
two-step flow: a **preview** (a dry run that writes nothing) and then **Import**.

## Two ways to bring the data

| Source | When to use it | How it works |
| --- | --- | --- |
| **Backup file** | Kuma 1.x (Settings > Backup > Export). Works from anywhere. | You pick the `.json` in the browser; the hub parses it. Up to about 4 MB. |
| **A server** | Kuma runs on a server Tugra already manages (SQLite, the default). | The hub asks that server's agent to run **one throw-away container** of a SQLite CLI image: no network, read-only root, all capabilities dropped, Kuma's data volume mounted **read-only**. It copies `kuma.db` (and its WAL) to a small tmpfs and runs three `SELECT`s there. The live database is never opened for writing; Kuma is not stopped. |

Both sources produce the same data, so the preview and the import behave the same.

Notes on the server source:

- It needs the **servers:ops** permission on a server of the team you import into, plus the `deploy`
  capability on that server (the one the agent already uses to run Docker).
- The image defaults to `keinos/sqlite3:latest` and is pulled by the host's Docker the first time. To pin
  or mirror it, set `KUMA_IMPORT_SQLITE_IMAGE` on the hub (a plain image reference, tag or digest).
- Kuma 2.x with **MariaDB** has no `kuma.db`; the import reports "No SQLite database found". Kuma 2.x
  removed the JSON backup, so for that case export the monitors you need from Kuma first or recreate them.
- The preview and the import each re-read the source. Nothing containing a secret is cached between steps.

## What is mapped

| Kuma | Tugra |
| --- | --- |
| HTTP(s) | Website check: method, accepted status codes (`200-299`, `401`, ...), headers, body, basic auth, ignore TLS errors, max redirects |
| HTTP(s) - Keyword | Keyword check (with "invert") |
| TCP Port | Port (TCP) check |
| Ping | Ping check (ICMP) |
| DNS | DNS check: record type and resolver (A, AAAA, CNAME, MX, NS, TXT, SRV, CAA, PTR) |
| Interval, retries, resend interval, timeout, paused, upside down | Interval, retries, "re-notify every N", timeout, disabled, upside down |
| Notifications | Alert channels: Telegram, Discord, Slack, Teams, Mattermost, Lark/Feishu, webhook, ntfy, Gotify, SMTP, Pushover |
| Monitor to notification links | Monitor to channel links |

Request headers, basic-auth credentials and bodies are stored **encrypted** (one `httpOptionsEnc` value per
monitor, covered by the secrets key rotation) and are never returned by the API; the monitor only reports
that request options are set.

Not imported, and shown in the preview with a reason: groups, push, Docker, database, MQTT, real-browser and
other Kuma types Tugra has no check for; certificate-expiry alerts; Kuma's separate retry interval (Tugra
retries on the normal interval); NTLM / OAuth / mTLS sign-in; heartbeat history; status pages; maintenance
windows; tags; proxies.

## Alerts are created only when you confirm

The preview lists every Kuma notification:

- **Already in your team** (same type and name): reused, no question asked.
- **New**: shown with a checkbox. Alerts used by a selected monitor are ticked; the others are not. Only
  ticked alerts are created. A monitor whose alert was not created is imported without that link.
- **Can't import**: unsupported provider, or required settings missing.

Creating alerts needs the **integrations** permission; importing monitors needs **monitors**. Channels go
through the normal channel validation, so a webhook or SMTP host that points at a private network is refused
exactly as when adding a channel by hand. A Kuma webhook keeps its URL and extra headers, but Tugra sends
its own JSON payload.

Importing the same file twice is safe: monitors that already exist in the team (same name, type and target)
are skipped.

## API

All under `POST /api/v1/monitors/import/kuma/`, team-scoped, token scopes `write` + `read:secrets`
(`detect`: `write`):

- `detect` `{ teamId, serverId }` lists Kuma containers on a server.
- `preview` `{ teamId, source }` returns the plan (no secrets).
- `apply` `{ teamId, source, monitorRefs?, createChannelRefs? }` writes and returns a per-item result.

`source` is `{ "kind": "backup", "json": "<file text>" }` or `{ "kind": "server", "serverId", "container?" }`.

## Cloudflare 520-526

When a website check gets a Cloudflare origin error (520-526) it records the cause `cf:<code>`. The monitor
page and alert messages then label the failure **Cloudflare <-> origin** and show the likely reason: server
down (521), connection timed out or a firewall blocking Cloudflare (522), no route to the server (523), slow
origin (524), SSL mode / certificate mismatch (525, 526), or an invalid answer (520).

## Parity notes

Uptime Kuma is MIT licensed. We read its backup format and its SQLite schema as a reference for field names
and edge cases (JSON-encoded status code lists, camelCase in the backup versus snake_case in the database,
notification `config` blobs). No Kuma code is copied.
