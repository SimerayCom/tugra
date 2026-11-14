# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **More resource limits for Image and Git apps.** Memory plus swap, a maximum process count, shared-memory
  size, CPU weight and CPU pinning, next to the existing memory and CPU limits. They are `docker run` flags, so
  Compose and Swarm apps refuse to set them (clearing is always allowed); the Resources card shows them for
  single-server apps. Unset, the run line is unchanged. A flag you also set in Docker options takes precedence.
  A rollback re-renders from the current settings, so it applies today's limits, not the ones from the deploy
  being restored.

- **Honest app status.** The app header, list and Overview now read from the container-health poll: Running,
  Running (unhealthy), Running (no healthcheck) or Starting, instead of the lifecycle status alone. A
  crash-looping container shows as unhealthy; missing or stale data never raises an alarm. HTTP and auto health
  checks still gate deploys only, so an app that relies on one reads plain Running. The app API gains
  `containerHealth`.

- **Per-app container operations and networking.** Set a graceful stop window (`--stop-timeout`, also used by
  deploy swaps, Stop and Restart), a drain pause for zero-downtime deploys (both versions keep serving for N
  seconds before the old one stops), a cap on `on-failure` restart retries, a stable container name that
  resolves on every network the app joins, and extra Docker networks per app. The app page shows the internal
  address other containers can reach it on. Unset, nothing about a deploy changes.
- **Behaviour change: apps without a domain now join the shared `tugra-apps` network.** A classic Image/Git app
  with no domain, no managed-database link and no `--network` in its Docker options is created on a per-server
  `tugra-apps` bridge on its next deploy instead of Docker's default bridge, so apps on the server can reach
  each other by container name. Anything that relied on default-bridge addressing (the `docker0` gateway, a
  fixed bridge IP) must be adjusted; add `--network` in the app's Docker options to keep full control.

- **Git and build settings per app.** Git submodules, Git LFS, shallow clone, disabling the build cache, passing
  env vars as build arguments, and a source commit mode (`SOURCE_COMMIT` off / runtime / build and runtime). Two
  behaviour changes for existing Git apps on their next deploy: the container now gets a runtime `SOURCE_COMMIT`
  env (a `SOURCE_COMMIT` you set yourself wins; Build settings, Source commit, Off opts out), and the clone
  exports `GIT_LFS_SKIP_SMUDGE=1` unless Git LFS is enabled, so LFS files stay pointer stubs (the build log
  warns when `.gitattributes` uses LFS). Submodules and LFS authenticate with the app's token for any repository
  on the same git host; previews never clone submodules or pull LFS. The agent image now ships `git-lfs`.

- **Breadcrumb shows the environment.** App and database pages now read Projects, project, environment, then the
  resource, and the environment crumb jumps straight to that environment's card on the project page.
- **Clone an app into another environment.** The clone dialog now has an Environment picker (this team's
  environments, defaulting to the app's own) and shows what was not carried over once the clone is created. The
  hub also checks the caller's access to the destination project when moving or cloning an app to another
  environment.
- **Link a Git provider from the app's Source card.** Pick a connected provider (GitHub App, Gitea, Forgejo,
  Codeberg) for a Git or Git-compose app, or unlink it, without leaving the app. Only this team's providers for
  the repository's host are offered, and a linked provider takes precedence over a stored personal access token.
  `GET /git-sources` now also returns each source's `cloneHost`.
- **"Links" menu in the app header.** Apps with more than one address (alias domains, per-service domains on a
  compose app, published compose ports) get a "Links (n)" menu that opens each one in a new tab, visible to every
  viewer; the Overview's Live URL row lists them all. Apps and `GET /apps` responses gain a `links` array (primary
  first); per-service domains are included on `GET /apps` and `GET /apps/:id` only.
- **Analytics tab on every app.** The same visitor analytics as the Traffic page (requests, status classes,
  bandwidth, latency, unique visitors, countries, paths, browsers), scoped to the app's own primary, alias and
  per-service domains, with a domain picker and clear empty states (no domain, analytics off on the server, no data
  yet). `GET /traffic/*` gains an `appId` filter that needs access to that app and can only narrow, never widen,
  what a caller sees. A clustered app shows traffic recorded on its own server only.

## [0.1.0-beta.12] - 2026-11-14

- **Per-deployment detail page.** Every deployment row opens its own page: a queued → started → finished
  timeline with queue wait and run time, who or what triggered it, the deployed commit (linked to the
  repository), image tag and digest, the configuration diff against the previous deployment, the full build
  log (following live while the deploy runs), and cancel / roll back / analyze actions — with honest notes
  when a deploy was interrupted, recovered, auto-rolled-back or cancelled. The deployments list no longer
  carries every build log, so the app page polls far less data.
- **PostgreSQL point-in-time recovery.** Enable PITR per database: WAL archiving is turned on with a verified
  restart, segments are shipped to the database's backup destination, physical base backups run on demand or
  on a schedule, and the panel shows the recoverable window with a picker to restore to any second into a new
  database. Retention is WAL-aware so a restorable base is never left without its WAL.
- **Restore-verify drills.** Prove a backup restores: on demand or on a schedule, the latest backup is
  restored into a disposable database and the result is recorded on the source; a watchdog alerts when the
  drill stops running or starts failing.
- **Fleet rollouts.** Deploy a release across many apps as canary → waves with a per-app health gate, a bake
  window, fail-fast halt, resume, and a one-click fleet rollback to each app's previous version, with
  notifications for halted / completed / rolled-back rollouts.
- **Post-cutover auto-rollback (opt-in per app).** Rolling deploys can keep the previous container through a
  soak window after traffic switches and revert automatically if the new version fails its health checks early.
- **Build secrets.** Dockerfile builds can mount secrets via BuildKit `--secret` so tokens never land in the
  image or its history (unlike build args).
- **Secrets key rotation.** Rotate `SECRETS_ENCRYPTION_KEY` without re-entering any secret or touching your
  apps (the hub restarts twice): keep the old key as a previous key, re-encrypt every stored secret from
  Settings → Instance, then drop the old key once the panel says it is safe.
- **Digest-pinned updates.** The signed release manifest now records each image's digest; the self-updater
  pulls hub and web by digest and refuses an image whose version label does not match the release. Older
  manifests keep updating by tag.
- **Safer installer and updater.** A mandatory pre-update restore point (database dump + `.env` copy) before
  any update; `X-Forwarded-For` is trusted only from private, loopback or explicitly listed proxy peers; an
  existing install turning HTTPS moves its raw ports to loopback (`--keep-raw-ports` opts out); atomic `.env`
  writes; the updater also refreshes the bundled agent; `bootstrap.sh` fetches by branch, tag or commit and
  leaves a checkout that `git pull` can update; abort paths restore the pre-run `.env`.
- **Deploys survive a hub restart.** A deploy that is running when the hub restarts (or when the agent's
  connection drops) is no longer marked failed blind. The agent keeps running it and keeps a local command
  journal; when it reconnects the hub picks the deploy back up and records the real outcome — success,
  failure, auto-rollback or cancelled — with the live log continuing in the panel. Only when the result
  genuinely cannot be known (the agent itself restarted, or it never reports back before the deadline) does
  the deploy show as interrupted, and the app's status is never changed on a guess. Requires the updated
  agent (older agents keep the previous behaviour until they are updated via *Update agent*).

## [0.1.0-beta.11] - 2026-11-12

- **Resumable queued deploys.** Single-server deploys still queued when the hub restarts are no longer dropped;
  they run when the server's agent reconnects. Deploys get a durable idempotency key so a retried request can
  never enqueue twice.
- **Agent reconnect fixes.** A reconnecting agent supersedes its stale socket instead of flipping offline; an
  agent self-update re-attaches its Docker networks so a single-box agent keeps reaching its hub.
- **Proxy churn fix.** Traefik is recreated only when its configuration actually changes, and per-server
  reconciles are coalesced, so a deploy no longer causes a brief edge outage for every app on the server.
- **Supply chain.** Postgres and Redis images are digest-pinned; every release ships Sigstore-signed SLSA
  provenance and an SBOM.
- **Server patching** returns a clean 503 when the agent is offline, self-heals an interrupted `dpkg`, and
  outwaits the host's patch backstop.

## [0.1.0-beta.7] – [0.1.0-beta.10] - 2026-11-11 / 2026-11-12

- **Protocol gate.** The hub refuses agents that are protocol-incompatible or older than an operator-set
  minimum, at enroll and at auth, with a clear reason.
- **Failed-update recovery.** A failed self-update actively restores and verifies the previous version; when
  that is impossible the panel shows a `recovery_required` state with the exact manual steps.
- **Idempotency leases.** Long requests hold their idempotency claim with a heartbeat so a retry never re-runs
  them.
- **Monitors.** A just-created metric monitor stays UP until its first sample; recovery is gated on sample
  freshness.
- **Volume backups** are labelled honestly as file-level copies, and volume restores are validated and
  snapshotted before anything is wiped.
- **MCP** grows to 53 tools (31 read, 22 mutate).
- **UI.** Deploy markers on metric charts, resizable live-log panel with tinted error lines, dismiss-safe
  toasts, a system theme option, accessible menus and confirmation dialogs, an opt-in feedback flow that
  prefills a GitHub issue, and an update badge in the top bar.

## [0.1.0-beta.6] - 2026-11-10

- **Traffic analytics.** A new Traffic page (under Monitor) with privacy-preserving, self-hosted visitor
  analytics, computed on your own server from the reverse proxy's access log — no third-party service and
  nothing leaves your machine. Enable it per server (Maintenance → Traffic analytics). It shows requests
  and bandwidth over time, a status-code breakdown, top paths, p95 latency, unique visitors, a bot/human
  split, and visitor browser, OS, device, referrer, country (with a world map), city and network
  breakdowns. Raw client IPs, User-Agents and Referers are aggregated locally and never sent to the hub;
  unique visitors use a HyperLogLog sketch that stores no IPs; query strings and path tokens are stripped.
  Country/city geolocation works out of the box via a bundled DB-IP Lite database (offline, no download).
- **Load average and swap in server monitoring.** The agent now reports 1/5/15-minute load average and
  swap usage; the server Monitoring tab shows a load-average chart and a swap-usage chart, and the live
  gauges show a swap meter and a load-average readout. Older agents simply omit them.
- **Cross-fleet hottest containers.** The dashboard now ranks the busiest containers across every server
  you can see, by CPU, each linking to its app or database.
- **Container type icons.** Each row in a server's container list carries a small type glyph
  (app, database, system, other) so the list scans by kind at a glance.

## [0.1.0-beta.5] - 2026-11-08

- **Cleaner server metric charts.** Metric charts now render two per row (wider and more readable)
  instead of being packed four or five across; Network in/out and Disk read/write are each combined
  into a single two-series chart with per-series values in the legend; and the dashboard fleet chart no
  longer reflows from full-width to two columns as its data loads.

## [0.1.0-beta.4] - 2026-11-08

- **Update checks now offer the next beta.** A version-comparison bug meant the panel never showed a
  newer beta of the same base version (e.g. 0.1.0-beta.2 → 0.1.0-beta.3) as available, so beta testers
  could not update from the panel. Pre-release versions are now ranked per SemVer §11.4, so the next
  beta is offered like any other update.
- **Polish from live-demo feedback.** The dashboard fleet tiles no longer reflow when metrics load; the
  beta notice banner no longer shows a stale version after an update; and the app header's
  Restart / Redeploy / Stop actions have clearer, distinct icons and grouping.

## [0.1.0-beta.3] - 2026-11-08

- **Panel UX overhaul.** A grouped, collapsible sidebar; consistent hover/focus/active states and
  accessible tabs across the panel; shared list cards with skeleton loaders and localized status
  labels; a sortable, filterable, paginated server table; a resize-aware multi-series chart
  primitive; a fleet-cockpit dashboard; fleet **Wall** and **Heatmap** metric views; and an
  unsaved-changes guard that warns before you navigate away from a config edit in progress.
- **Dokploy import now carries ingress.** Importing from Dokploy brings over domains, TLS / cert
  type, path routing, redirects and HTTP basic-auth (fetched secret-free), not just the app itself.

- **Fixed: an agent could permanently brick its own identity on a transient hub rejection.** On any
  rejected reconnect with an enroll token set, the agent used to erase its stored identity and fall back
  to enrollment — which cannot succeed for an already-enrolled server, so a mid-handshake hub restart or
  a brief DB hiccup left the agent looping on "rejected" forever (control plane down until a manual
  re-enroll). Now the hub distinguishes an unknown identity (server row gone / never enrolled → it asks
  the agent to re-enroll via an explicit `code: "reenroll"`) from a generic/transient rejection, and the
  agent discards its identity **only** on that explicit signal — and even then not until a fresh enroll
  succeeds, so a spurious signal can never destroy a good identity. A persistent bad-signature is now
  logged on the hub. Rollout: the fix takes effect agent-side, so **upgrade the hub first, then push the
  agent update** (an un-upgraded agent keeps the old behaviour until it updates).
- **Automatic HTTPS for the control panel (opt-in).** `install.sh --domain <host> --auto-tls --acme-email
  <you@domain>` now provisions the panel's TLS itself — the bundled Traefik gets a Let's Encrypt certificate
  and path-routes the single origin, with no hand-written reverse-proxy config. Works behind Cloudflare (a
  grey DNS record, SSL mode Full, or a DNS-01 token). Opt-in: plain `--domain` stays bring-your-own-proxy and
  the only outbound call is to Let's Encrypt for your own domain (no phone-home). The hub and web join a
  dedicated `tugra-panel` Docker network that Traefik routes over, isolated from deployed apps. Before
  provisioning, the installer sanity-checks the domain — that its A record points at this server (HTTP-01)
  or that the Cloudflare token is valid (DNS-01) — and prints the exact fix up front instead of letting the
  certificate fail silently. Check or re-apply from **Settings → Panel HTTPS** (`GET`/`POST
  /instance/panel-tls`). See [docs/install.md](docs/install.md).
- **Turnkey add-server:** the agent installer now auto-installs Docker (via get.docker.com) when it's
  missing and the script runs as root — matching the hub installer, so adding a second/remote server is a
  single pasted command. Opt out with `TUGRA_SKIP_DOCKER_INSTALL=1`; a non-root run still prints the manual
  install hint (nothing half-installs).
- One-click Coolify database migration: after importing a Coolify fleet, mint a one-time migration
  token for the import operation and paste the printed one-liner on the Coolify host. It dumps each
  Postgres, MySQL, MariaDB, Redis, KeyDB and Dragonfly database and restores it into the matching
  Tugra database — cross-host, with the token only ever in the environment and no database password
  ever reaching the hub. MongoDB, ClickHouse, LibSQL and app volumes stay on the manual runbook.
  See [docs/coolify-migration.md](docs/coolify-migration.md).
- Coolify import env-remap: a read-only preview, then a confirm-gated apply, rewrites each migrated
  app's environment to point at its new Tugra database (secret-masked diff, a `planHash` the apply must
  match, and a one-call undo). Cross-host/swarm/compose apps are shown as needs-manual, never half-wired.
- Managed-DB network link: an app can opt into the node-local `tugra-net` so a migrated (or native)
  co-located app reaches its database by container name; the env-remap apply wires eligible apps in.
- OS patching now patches the **host**, not the agent's own container. It runs the package manager in
  the host namespaces via a one-shot privileged helper launched from the agent's image, and fails
  closed (a clear error, never a silent container-only patch) if it cannot enter the host.
- **Anonymous usage stats (on by default, opt-out).** The hub now sends a once-a-day anonymous ping:
  aggregate counts (servers, apps, databases, deploys, teams, users, clusters, monitors, containers)
  plus its version, edition and OS/arch, keyed by a random, stable instance id. The payload carries no
  IP, hostname, domain, email, app or server name, and the receiver does not store the sender's IP. See
  the exact payload — and opt out — in **Settings → Anonymous usage stats**, or set `TUGRA_TELEMETRY=0`
  (a hard off that the installer's `--no-telemetry` writes). Every outbound connection Tugra can make is
  inventoried in [docs/security.md](docs/security.md).
  **⚠️ Upgrading from a pre-telemetry release (0.1.x):** earlier versions made no such call. This upgrade
  turns the stats **on** — if you want to stay off, set `TUGRA_TELEMETRY=0` (or flip the Settings toggle)
  after upgrading.
- **No update ping, IP probe or version checks by default.** A fresh install makes no update ping, no
  public-IP probe, no Prisma version check and no Traefik version check (anonymous usage stats above are
  the one deliberate default-on call) — otherwise it contacts only the registries it pulls images from.
  Update checks are opt-in (`install.sh --enable-update-checks`, or `UPDATE_MANIFEST_URL`/`_PUBLISHER_KEY`
  in `.env`); public-IP detection is opt-in (`--detect-public-ip`, or pin one with `--public-ip <ip>`).
  **Existing installs:** your `.env` keeps `UPDATE_MANIFEST_URL`, `UPDATE_PUBLISHER_KEY` and
  `LOCAL_SERVER_PUBLIC_IP` from the previous installer (values are written once). To stop update checks,
  blank those three keys and restart hub-api; leave them to keep update checks on.
- **Operator notice banner.** A signed, top-level `notice` in the update manifest shows the instance owner
  a dismissible banner (info / warning / critical) on every page — an announcement decoupled from releases
  (security advisory, "please upgrade", maintenance). Published or cleared without cutting a release via the
  **Publish notice** workflow (`gh workflow run notice.yml`); the message is plain text and any link is
  https-only. A release carries an active notice forward unchanged.
- **Per-app proxy controls.** Per-app rate limiting, an IP allow-list, HTTP basic-auth, path-prefix routing
  (serve an app under `<domain>/<prefix>`), and custom regex redirects — all through Traefik middlewares,
  configured from the app's domain/options card.
- **More deploy controls.** Tunable health-check timings + expected status; a per-app restart policy; pin a
  Git deploy to a specific commit SHA; watch-paths (deploy only when matching files change); container
  ENTRYPOINT/CMD override; Dockerfile build `--target`; extra published ports (multi-port TCP/UDP) for
  docker-run apps; a per-app auto-deploy switch with Gitea/Forgejo and Bitbucket webhook signatures; exclude
  env vars from PR previews; and a cap on concurrent PR previews (oldest evicted).
- **Operator-authored Traefik dynamic config.** A server admin can create/edit/delete raw Traefik dynamic
  YAML (middlewares, TLS options, services), validated and hot-reloaded into the proxy — server-scoped, so
  it never reopens the per-app label surface.
- **External secret stores (Vault).** Reference secrets from HashiCorp Vault, injected at deploy time, with
  a providers page and a per-app "external secrets" card (Pro).
- **Backups:** cron-expression schedules and age-based retention, alongside the existing copy-count retention.
- **Icons everywhere:** upload a custom icon for projects, teams and databases (parity with app icons), and
  opt in to also remove images when deleting an app (reclaim disk).
- **Servers:** a description and timezone per server (the timezone drives the cleanup cron), and a default
  disk-usage monitor auto-provisioned on enrollment.
- **`tugra-cli` on npm.** The command-line client is published as [`tugra-cli`](https://www.npmjs.com/package/tugra-cli)
  (`npm i -g tugra-cli`) — drive the hub's REST API from the terminal or CI.
- **Fixed:** the installer now persists a pinned `TUGRA_VERSION` to `.env`, so a version-pinned install (e.g.
  a beta) survives restarts instead of drifting back to `:latest`.
- **Security:** per-app `dockerOptions` can no longer set `traefik.*` labels, `--name`, `--env-file` or
  `--label-file` — closing a cross-tenant router-hijack surface. The operator dynamic-config editor above is
  the sanctioned, server-scoped way to author proxy rules.

## [0.1.3] - 2026-10-20

- Database live logs: stream and download a database container's logs from a new Logs
  tab, the same viewer applications already use.
- Fleet-wide OS updates: check and apply OS package updates across many servers at once
  from the servers bulk bar; reboots are never automatic.
- Smoother navigation: clicking anywhere on a server, project or cluster-member row opens
  it, and database and project lists now show the engine's brand icon.
- Clearer wording: database actions now read Deploy / Redeploy (was Provision).
- Releases now publish GitHub release notes from this changelog.

## [0.1.2] - 2026-10-20

- Smoother create to deploy flow: new apps and databases start right away (opt-out
  per resource), with live deploy output, status-aware actions and clearer empty states.
- Panel polish: team badges in the all-teams project list, a reveal toggle for secret
  connection fields, and a clearer message when a shell target is not running yet.

## [0.1.1] - 2026-10-20

- Turnkey quick start: a one-command installer (`scripts/bootstrap.sh`) that installs
  prerequisites, sets up Docker automatically, and shows a startup banner, a requirements
  check and step-by-step progress.
- The bundled single-box agent connects automatically after owner setup; the web UI,
  terminal and webhooks resolve the hub's public address at runtime.
- Agent resilience (re-enrollment, a larger message limit, process-group command timeouts)
  and a safer self-update (post-update health check with automatic rollback).

## [0.1.0] - 2026-10-20

Initial public release. Tugra is a self-hostable control plane for deploying, monitoring, backing up
and orchestrating servers — from a single Raspberry Pi to a fleet.

**2026-10-05**

- **One-click Cloudflare DNS setup** — store a Cloudflare API token as a team DNS credential, then set up a
  custom domain in one step: Tugra creates the apex `A`/`AAAA` records (one per cluster-ingress node for
  failover) plus an optional `www` `CNAME` and wires the app's HTTPS (`POST /apps/:id/domain/auto-setup`,
  with dry-run preview and an explicit `overwrite`). Copy-paste records for any other DNS provider
  (`GET /apps/:id/domain/manual-records`), propagation check (`POST /apps/:id/domain/verify`) and teardown
  (`DELETE /apps/:id/domain/dns`) are included, as is the `tugra apps domain` CLI command and the
  `setup_app_domain` / `verify_app_domain` MCP tools. Cloudflare only in this release; records are created
  DNS-only (never proxied) to avoid the Flexible-SSL redirect loop; a record that points elsewhere is
  replaced only with `overwrite`, and `TXT`/`MX` records are never touched.
- **Personal-access-token API parity** — teams, notification channels, registries, Git sources, cloud
  credentials, the audit log and saved views are now reachable with scope-checked PATs (and the CLI), not
  only a browser session; the same team-permission checks still apply. Token management stays session-only.
  Hardened audit-log redaction and team-permission checks.
- **Per-token API rate limits** — each personal-access-token request is counted against its own budget (default
  300 req / 60s, `API_RATE_LIMIT` / `API_RATE_WINDOW_SEC`) on top of the global per-IP throttle; responses carry
  `X-RateLimit-Limit`/`-Remaining`/`-Reset` and an over-budget call returns `429` with `Retry-After`. Browser
  sessions are unaffected, and a Redis outage fails open. (Pagination and a richer CLI/SDK are still planned.)

### Added

- **Deploy** — from Git (Nixpacks / Dockerfile / static-site), Docker Compose, or a container image;
  preview deployments per pull request; rollbacks, resource limits and health checks.
- **Domains & TLS** — custom domains behind an automatic reverse proxy (Traefik), with Let's Encrypt
  certificates via HTTP-01 and DNS-01 (wildcard) challenges.
- **Databases** — managed databases across 9 engines (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB,
  Dragonfly, ClickHouse, LibSQL), with backups to local storage or S3/R2-compatible off-site storage,
  and one-click restore.
- **Monitoring & notifications** — uptime monitors (HTTP/TCP/metric checks) with configurable
  notification channels.
- **Clustering** — Docker Swarm-based multi-server clusters, with fleet-wide bulk operations. The overlay
  network is now **encrypted by default** (VXLAN + IPsec) for inter-node traffic; a background health check
  alerts (`swarm_degraded` notification) when a cluster drops from healthy to degraded; per-app soft resource
  reservations (`--reserve-memory`/`--reserve-cpu`) are supported for swarm scheduling; and stop/start now
  waits for the service to actually converge.
- **MCP server** — a built-in [Model Context Protocol](docs/api.md#mcp-server) server
  (`POST /api/v1/mcp`) with 46 tools for AI assistants and agents: 25 read tools (applications,
  servers, clusters, databases, monitors, fleet rollups, a read-only volume file browser) + guided
  prompts, plus 21 PAT-scoped mutate/ops tools (app lifecycle +
  live scale, env config, swarm operations, one-click domain DNS setup/verify, and a preview-then-confirm
  fleet action). Irreversible tools (dissolve a swarm, remove an app) require echoing the resource name;
  OAuth for third-party clients is still planned.
- **Web dashboard** — the Next.js web UI covering deployment, monitoring, backups, teams/projects and
  instance settings.
- **Public API & CLI** — a versioned REST API (OpenAPI) and the `tugra` CLI.
- **Platform** — signed hub↔agent protocol (dial-out WSS, ed25519-signed commands, capability scoping),
  teams/roles/invites, projects & environments, scheduled tasks, server patching, and signed self-update.
