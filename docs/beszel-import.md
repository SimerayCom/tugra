# Importing from Beszel

Tugra can read a Beszel hub and bring over its servers, alert rules, notification channels and up to 30 days of history. Open **Import, Import from Beszel**, sign in with the account you use in Beszel, review the preview, then press Import. Nothing is written until you do, and nothing in Beszel is changed.

## What is read

Beszel is a PocketBase app. Tugra signs in with PocketBase password auth (a Beszel user first, a superuser as a fallback) and reads these collections with that login:

| Collection | Used for |
| --- | --- |
| `systems` | name and host of each monitored system |
| `alerts` | rule name, threshold (`value`) and window in minutes (`min`) per system |
| `user_settings` | the user's notification URLs (`settings.webhooks`) and email list |
| `system_stats` | the history (`1m`, `10m`, `20m`, `120m`, `480m` resolutions) |

A Beszel user only sees their own alerts and settings, so import with the account that owns them.

## How things map

- **Servers.** Matched to your Tugra servers by address (public or reported IP), then by hostname or name. A system that matches nothing, or more than one server, is listed so you can pick a server by hand or leave it out.
- **Alert rules.** CPU, Memory, Disk, Temperature, Bandwidth and Load 1/5/15 become metric monitors on the matched server (checked every minute; a rule with a window of N minutes alerts after N one-minute checks in a row). A Beszel `Status` rule is covered by Tugra's built-in server-offline alert. Battery, GPU, CPU I/O wait and steal, container, service and disk-health rules are listed as not carried.
- **Notification channels.** Beszel stores shoutrrr-style URLs. Discord, Slack webhooks, Telegram, ntfy, Gotify, Pushover, Teams, Mattermost, Lark, SMTP and generic webhooks become Tugra channels; other services are listed as not carried. A generic webhook receives Tugra's own payload, not Beszel's. Email addresses in Beszel are not imported.
- **History.** Rolled into Tugra's one-minute rollups for each matched server, each Beszel resolution only inside its own window, never over data Tugra already holds and never older than Tugra's rollup retention (`METRICS_ROLLUP_RETENTION_DAYS`, 30 by default). Temperature and per-container history are not imported.

## Credentials

The Beszel password is stored encrypted for the import only and deleted when it finishes. "Keep these credentials" keeps the connection for 30 days so a later visit can preview again without signing in; it can be forgotten at any time.

Re-running is safe: an equal monitor or channel is reused, and history never overwrites an existing bucket.
