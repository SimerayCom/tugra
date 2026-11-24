# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **A Coolify import keeps its projects, and the review selects by project in one click.** The import now reads Coolify's
  project → environment tree (`/projects`, `environment_id` on each app and database), so every resource is placed in a
  Tugra project/environment named after its Coolify one (IsBulKibris / production) instead of the team default, exactly
  like a Dokploy import. The review screen shows **Include all / Exclude all** above the list and **Include / Exclude
  this project** on each project group, so taking one project out of a team is two clicks. An unreadable project list
  leaves resources in the team default and says so in the plan.

## [0.1.0-beta.26] - 2026-11-23

- **Connect a Git source once, use it in every team.** The instance owner can mark a GitHub App or Gitea-family source
  **Share with all teams** (Git Sources). Every team can then import and deploy the repositories it can see: the import's
  repo linking, app create/link, and the repo/branch pickers all accept a shared source; other teams see it read-only
  with an "All teams" badge. Only the instance owner can share or stop sharing (`PATCH /git-sources/:id/sharing`, `admin`
  scope for a token), and each change is audited.
  Linking a shared source to an app in another team is reserved for the instance owner or a manager of the source's own
  team; ordinary members of other teams see it read-only and cannot attach it to new apps (apps already linked keep
  deploying through it).

## [0.1.0-beta.25] - 2026-11-23

- **Servers behind a Cloudflare-proxied hub get their real IP, hostname and OS.** With the panel on Cloudflare's orange
  cloud, every agent connection reached the hub from a Cloudflare edge address, so a new server was recorded with
  Cloudflare's IP (wrong magic URLs, DNS hints and allowlists), and every server showed its agent container's id and
  Debian instead of the host. Now: the installer turns the verified CF-Connecting-IP mode on by itself when the panel's
  DNS resolves to Cloudflare (`--no-cloudflare-proxy` still turns it off); the hub never records a Cloudflare edge
  address as a server IP and repairs one already stored; the agent reads the host's hostname and OS from the Docker
  daemon and its interface addresses through a short-lived, read-only, capability-stripped helper on the host network
  (the agent's own image, nothing pulled); and a real public IPv4 always wins over a Tailscale/CGNAT `100.64/10` one.
- **Host facts are captured at install time, on the host.** The agent installer (and the hub installer for the local
  agent) records the host's hostname, OS and interface IPs (every global address, IPv4 and IPv6, Docker interfaces
  skipped) in `/etc/tugra/host-facts.json` before the agent container starts, so the hub knows the real server from the
  first connect; the agent refreshes the same facts at runtime and the hub keeps the full list of addresses.

## [0.1.0-beta.24] - 2026-11-23

- **The installer tells you what is in the way, and `install.sh --doctor` checks a host read-only.** The install used to
  print one line like "Port 80 looks busy". It now names who holds `80`/`443` (and the raw hub/web ports): the process from
  `ss -ltnp`, or the container behind `docker-proxy`, with specific advice for nginx, Apache, Caddy, CloudPanel, Plesk,
  cPanel, Coolify's proxy, another Tugra and anything else, naming the exact command and what it would take down; nothing
  is stopped or changed. It also reads the host firewall (ufw, firewalld, nftables, iptables) and prints the one-line command
  when `80`/`443` are blocked, explains that Docker-published ports bypass ufw, recognises the hosting provider locally
  (DMI, cloud-init, hostname; no network call) for Hetzner, AWS, Google Cloud, Azure, DigitalOcean, Vultr, Linode/Akamai,
  Oracle, Scaleway, OVHcloud, Contabo and generic KVM and says where its cloud firewall is, and flags a missing IPv6 or an
  AAAA record that points elsewhere. `./scripts/install.sh --doctor` (also `curl … | sh -s -- --doctor`) runs all of it on a
  fresh or installed host and adds the Tugra state: containers, the proxy and its routes on loopback, the certificate for the
  panel domain and the local agent, each problem with its fix; exit 0 when fine, 1 otherwise. It never changes anything,
  and neither does `curl … | sh -s -- --doctor`: the bootstrap then installs no git and fetches or moves no checkout (it runs
  the one the host has, or a throwaway copy). A blocked `80`/`443` is a red cross only for a host program that serves it
  (Docker-published ports skip INPUT rules), an agent that `Update agent` recreated outside compose is found, a firewall
  that cannot be read without root is reported as unknown, and a bring-your-own-proxy or raw-port install gets its own
  advice. The agent now logs `hub session on <url> established` on every successful connect, which is what the doctor
  reads. See [Troubleshooting](docs/install.md#troubleshooting).

- **Agents follow the hub when its address changes, and talk to it encrypted even on a bare IP.** The agent used to hold one
  URL fixed at install: an IP-mode hub meant plaintext `ws://<ip>/agent`, and setting, changing or removing the panel domain
  dropped the old route so every remote agent was stranded until re-installed by hand. Now each agent keeps an ordered,
  persisted list of hub endpoints (primary + fallbacks; rotation with backoff, primary first after every drop, survives
  restarts and self-updates) and the hub pushes it in a signed `hub_endpoints` message on connect and on every change. The
  panel-domain flow pushes the new address to all connected agents **before** the switch and keeps the old host and the IP
  route answering `/agent` until every agent reports the new address, you press **Stop waiting**, or 7 days pass; Settings →
  Panel domain shows "N of M agents moved to the new address" and which ones did not. Every endpoint must present the hub
  key pinned at enroll and prove it with a per-connection signature; in IP mode the hub serves `wss://<ip>/agent` with one
  persisted self-signed certificate, the add-server command carries its SHA-256 fingerprint (`--hub-pin`) and the agent pins
  the leaf. Plain `ws://` now needs an explicit `--hub-insecure` (existing installs keep working) and the UI warns about it.
  Agents that predate this keep working on their single URL. New owner-only `POST /instance/panel-domain/agents/release`
  (OpenAPI and CLI schema regenerated).

- **A plain install is reachable on port 80, and HTTPS needs no Cloudflare token.** Without `--domain` the panel now comes
  up on `http://<server-ip>/` through Tugra's own proxy (the same single-origin routing as a domain install), so a host
  that only opens 80/443 works out of the box and the URL is printed at the end of the install. An existing install keeps
  its own setup (stored `.env` values win; a flag-less upgrade never moves the panel), `--raw-ports` keeps the classic
  `:3000`/`:3001` layout, and a host whose port 80 is taken falls back to it with a note. `--domain` now provisions the
  panel's HTTPS itself by default (Let's Encrypt HTTP-01, no email required; `--no-auto-tls` or an occupied :80/:443
  keeps bring-your-own-proxy). Behind a Cloudflare orange-cloud proxy the installer no longer says a token is needed:
  HTTP-01 is tried first and, only if it fails, it explains SSL mode Full / Always Use HTTPS off; `--acme-dns-cloudflare`
  stays as an option. A re-run never moves an existing install: an IP-mode install whose proxy probe misses is left as it is
  (the raw-port fallback is only for the run that first enables IP mode), an install already served over https by its own
  proxy keeps it unless `--auto-tls` is given, and a cloud server whose interface address is private is told to pass `--public-ip`.
- **Set, change or remove the panel domain from Settings.** Settings → Instance → Panel domain (owner only) does what
  `install.sh --domain` did: it adds the domain's routes next to the current address, waits for the Let's Encrypt
  certificate, then switches the public URLs and recreates hub and web through the update helper, and only reports done
  once the new address answers from the server through the public DNS/proxy path. A certificate, startup or reachability
  failure rolls everything back with the previous address restored and the reason shown; a change the hub gave up on is
  never applied late, and a raw hub/web port still published on every interface moves to loopback with the domain. New owner-only
  `GET /instance/panel-domain`, `POST /instance/panel-domain` and `POST /instance/panel-domain/remove` (OpenAPI and CLI
  schema regenerated); the change is audit-logged.
- **The one-line install now installs the newest published release.** `curl … bootstrap.sh | sh` used to check out
  the development branch and, with no stable release published yet, fall back to building that unreleased code on
  the server. It now picks the highest release tag (stable over pre-release, numeric beta order) and its prebuilt
  images; `TUGRA_REF=main` still installs the development branch on purpose.
- **The Coolify import plan now says what the dry run used to hide.** Scheduled database backups (and the S3 target they
  upload to, by name only, never its keys) are listed as not carried, with a plan warning to recreate them in Tugra's
  Backups. Apps that are dead or crash-looping at the source (status and restart count) are named in the plan warnings and
  the preflight. A MinIO volume no longer shows as copied by the import (its data moves through Object migration), service
  host-path binds now need the same bind-mount acknowledgement as an app's, and source servers that report no operating
  system get a warning that it is only checked when the agent enrols.
- **Image cleanup and the disk check no longer misfire on a busy server.** A shell race could make the updater
  miss its own release images: cleanup then removed nothing and the disk check under-estimated the space an update
  needs. The same race could also mislabel a disk-full pull as a generic pull failure.
- **Discover & adopt never offers Tugra's own containers.** The install stack (hub, web, agent, updater and its bundled
  postgres/redis), the proxy, Tugra-run tunnels, helper containers and anything Tugra already manages are hidden from
  the scan, and adopting one directly (API, MCP or CLI) is refused before anything is renamed.

## [0.1.0-beta.23] - 2026-11-18

- **An in-app update can no longer leave the server half-updated.** Before anything is written or pulled, the updater
  checks free space on Docker's data root (and prunes old Tugra images first if short); if it still does not fit it stops
  with the numbers ("needs about X GB free on <path>, has Y GB") and touches nothing. The target images are pulled and
  verified BEFORE `.env` changes, and every `.env` write is atomic, so a full disk can no longer leave `.env` naming a
  version that never installed. A half-finished update (`.env` ahead of the running stack) is detected: "Update now"
  finishes it, or sets `.env` back to the running version if the target cannot be pulled, and Settings > Updates explains
  it with a "Finish update" button. A failed update always shows its cause. `install.sh` runs the same disk check and
  re-runs cleanly on a half-updated install. An install already stuck by an older updater is repaired once with
  `TUGRA_VERSION=<version> ./scripts/install.sh` (see docs/upgrade.md).

## [0.1.0-beta.22] - 2026-11-17

- **Out-of-band cloud access (Hetzner first).** For servers linked to a Hetzner Cloud server, the panel, CLI and MCP can
  power on, shut down, hard power off, hard reset, enable/disable rescue mode and open the provider console, even with
  the agent offline. Destructive actions need a typed server-name confirmation and are audited first; the rescue root
  password and console session are shown once and never stored. Existing servers can be linked by hand
  (`providerManualLink`; a hand-linked VM is never destroyed when the server is deleted in Tugra).
- **Coolify connect errors say what is wrong.** A Coolify 403 shows Coolify's own message and the single fix that matches
  it (add the hub's address to Allowed IPs, enable the API, use a whole-team token, a token no wider than its creator, or
  the missing ability). The import wizard shows the hub's public egress IP (`IMPORT_EGRESS_IP` overrides it).
- **Coolify apps with a custom container name prefix** are found by the freeze, inventory, cross-check and volume copy.
- **Security review of everything added since beta.17** (`docs/security/2026-11-review.md`): the updater refuses a queued
  target version that is not a plain version string, and package names ending in "-" (an apt removal) are refused.
- README roadmap updated through beta.21 in all eight languages.

- **Guided migration works against Coolify 4.7.5.** Checked against a live 4.7.5 instance:
  - Application containers named `<uuid>-YYYYMMDDTHHMMSS` (4.7) are found by the agent's volume resolution and by the
    freeze, inventory and cross-check steps; the old `<uuid>-<digits>` names still work.
  - The Coolify API client paces itself under Coolify's per-user limit (all of a user's tokens share it), waits out a 429
    `Retry-After`, and stops after repeated 401/403 so a bad token is not locked out.
  - Database and service start/stop treat "already stopped/running" as done, stops no longer trigger Coolify's Docker
    cleanup on the source, and the token needs the `deploy` ability (plus `read:sensitive`, created by a team admin or
    owner); the labels, hints and docs say so.
  - When a token cannot read build/start commands and other sensitive fields, the plan warns instead of carrying apps
    without them; locked (shown-once) variables are reported as locked, not as a token problem.
  - Static/SPA settings are read from the application detail, compose apps keep their per-service domains, the git
    provider comes from `source_type`, removed service members are skipped, and Valkey databases are carried as Valkey or
    refused with a clear reason.
  - Printed decommission commands skip control-plane containers the host does not have and include coolify-sentinel.
  - The migration lab has a Coolify 4.7.5 profile (rate limit, 400 on already stopped/running, ISO container names).

## [0.1.0-beta.21] - 2026-11-17

- **Reboot a server from the panel, and see that everything came back.** The server's Maintenance tab has a Reboot card
  (now, or scheduled up to 7 days ahead) with an impact preview (containers and domains briefly unavailable, a warning when
  the server hosts the Tugra hub) and a typed server-name confirmation; the Server patching "reboot required" banner links
  to it. After the reboot Tugra verifies on its own that Docker is up, every container that was running came back (healthy
  if it has a healthcheck), every routed domain answers through the proxy and the reboot-required flag cleared, then shows
  a per-item report and notifies (server_reboot_verified / degraded / failed). Things already down before the reboot are
  reported as such, not blamed on it. A scheduled reboot that missed its time while the hub was down is never run late.
  Reboots stay manual: nothing reboots automatically. Also in the CLI (`tugra servers reboot`, `reboot-status`,
  `reboot-cancel`) and MCP (`reboot_server`, typed confirmation required).

- **Server patching explains Ubuntu's phased updates.** Packages Ubuntu is rolling out gradually are no longer counted as
  pending: they appear in their own section ("installs automatically when this server's turn comes") with an Install now
  button for one package, Update all never claims them, and the result says "deferred by Ubuntu's phased rollout" instead
  of the generic "may be held back".

- **In-app updates keep the install's git checkout clean.** After applying a release's compose file and scripts, the updater
  moves the checkout to the release tag when the files are byte-identical, so `git pull` and `git checkout <tag>` work
  again. Real local edits are backed up, reported and never discarded; local commits are never orphaned. `install.sh`
  re-runs on such a checkout proceed, and `install.sh --sync-checkout` repairs one the updater could not clean.

## [0.1.0-beta.20] - 2026-11-17

- **Server patching survives a container-engine upgrade.** "Update all" and single-package updates now run the package
  manager on the host as a transient systemd unit (`tugra-patch-<id>`), outside the container that starts them, so a
  docker-ce/containerd upgrade restarting Docker no longer kills the update half-way and leaves the engine half-configured;
  the panel re-attaches to the running unit when the agent reconnects and shows its full log. A check is read-only: an
  interrupted dpkg is reported as its own finding (with whether the container engine is involved), never repaired
  silently, and an update that would restart Docker asks first. Hosts without systemd refuse engine packages from inside
  the container. Patch audit entries are written when the run starts.
- **Traefik always routes through the proxy network.** The proxy runs with `--providers.docker.network=tugra-proxy` and every
  routed container carries `traefik.docker.network=tugra-proxy`, so an app or compose service attached to several networks
  no longer hangs after a Docker restart because Traefik picked an IP on a network it is not on. Existing proxies are
  recreated once on their next reconcile.
- **The updater cleans up and catches up.** After an update, Tugra's own release images older than the previous release are
  removed (`TUGRA_PRUNE_IMAGES=0` keeps them; the installer offers `--prune-images`). The local agent is pulled by its
  per-platform digest from the signed manifest, which also works on Docker's containerd image store. An updater that
  predates self-refresh is recreated on the release image by the hub through the local agent, and the panel shows the
  updater's version.
- **Docker cleanup runs like Coolify's.** Besides the daily 03:00 run, a server whose disk passes its threshold (default 80%)
  gets an extra run at most once an hour; new servers are scheduled within minutes, and servers that were never configured
  are switched on while an operator's explicit "off" is kept. The server page shows what cleanup deletes and what it never
  deletes.

## [0.1.0-beta.19] - 2026-11-17

- **Compose services come back after a Docker restart or a reboot.** Every compose member that sets no restart
  policy (App Store templates, pasted and git compose stacks, previews) now gets `restart: unless-stopped` through
  Tugra's override file; an explicit `restart` (including `"no"`) and init/one-shot members are left alone. Running
  stored-compose services are healed with `docker update --restart unless-stopped` within about 15 minutes, without a
  redeploy or a restart.
- **App logs open at once.** A compose app's Logs tab streams its main service immediately (the picker still
  switches), and the app header and crash timeline follow a container that comes back within seconds; a stopped
  container no longer shows a stale "Unhealthy".
- **Server patching confirms and refreshes.** After "Update all" or a single package the panel re-checks on its
  own, clears applied packages and reports how many were updated; when the update restarts Docker it waits for the
  agent to reconnect instead of leaving the old list on screen.
- **No false SSL errors for http-only domains.** Domains served without TLS (such as sslip.io app domains) are shown
  as "HTTP only" and no longer listed under Needs attention; a domain that should have a certificate still is.
- **The in-app updater updates itself.** After every update the updater sidecar is recreated on the new release image
  (it used to stay on the version it was installed with), and an updater left behind catches up when it starts.

## [0.1.0-beta.18] - 2026-11-17

- **Guided migration runs from Coolify (preview).** One resumable, observable, abortable run now chains what the
  manual runbooks did step by step: preflight, config import, environment remap, dark deploy, data seed, freeze, final
  data copy, TLS pre-issue, verification, DNS prepare, cutover, an observe window and finalize, plus an optional
  decommission of the source for takeover runs. Each step has gates you can read, typed approvals at the freeze and at
  the point of no return, and an abort that hands authority back to Coolify until that point. Runs survive a hub
  restart and pick up where they stopped. Start one from the import wizard ("Run guided migration"), the new
  **Guided migrations** pages, `tugra import run ...`, the `migration_run_*` MCP tools or `/migration-runs`. The
  point-of-no-return approval is refused over MCP. Always start with a dry run: it writes nothing outside its own run
  rows. The engine is covered by tests against in-memory fakes; it has not yet been driven against a live Coolify
  fleet, so read the verification status in `docs/runbooks/guided-migration.md` first.
- **PostgreSQL 18 databases keep their data across a container recreate.** PostgreSQL 18 stores its cluster under
  `/var/lib/postgresql/18/docker`, outside the path Tugra mounted, so the data of a Tugra-provisioned PostgreSQL 18
  database lived in an anonymous Docker volume. New PostgreSQL 18 databases now mount their data volume where the cluster
  lives. Existing PostgreSQL 18 databases keep working: their anonymous volume is re-attached on every recreate, and the
  database page shows a warning with the remedy (back up, restore into a new database, switch the apps over). Point-in-time
  restore now works for PostgreSQL 18 targets.
- **Guided migration fleet readiness.**
  - Data: the streamed dump restores into PostgreSQL 18; compose-service volumes (search indexes, converter state) copy
    through the streamed lane with resume; a slow link no longer loses a part's lease; a measured link speed
    (`--speedtest-mib`) feeds the per-host window estimate.
  - Gates: VERIFY, CUTOVER and OBSERVE treat apps already unhealthy at the source as pre-existing warnings while a new
    failure still fails; DATA_FINAL of the host-loop runner names a dead host; the downtime estimate includes builds,
    starts, health checks, certificates and the bytes crossing the hub twice, and the FREEZE approval shows every term; a
    write gap longer than the accepted minutes needs an explicit attestation at FREEZE; a plan with object-storage
    dependants and no object migration stops at DATA_SEED unless the policy is external.
  - Services: DEPLOY_DARK starts the services dark apps depend on first (`serviceStart`); VERIFY lists uncopied service
    volumes as not migrated.
  - Import: Coolify watch paths, static sites, redirect mode and custom `redis.conf` are carried or reported; env values
    pointing at an unresolved Coolify container are flagged; the host inventory records image digests and pins
    floating-tag apps; `unlistedDbPolicy: carry` moves unlisted PostgreSQL, MySQL, MariaDB, Redis, KeyDB and Dragonfly
    containers into new Tugra databases.
  - Operations: PREFLIGHT checks free disk and backups on every target server and flags the control-plane host, flaky
    hosts and very new OS releases; decommissioning the Coolify control-plane host waits for every other run of the
    same source; a campaign report page and `tugra import run report --campaign <name>`; held workers and source server
    names in the panel.
  - Known limits: dumps carry data and schema but not roles, grants or MariaDB stored routines (Tugra creates its own
    owner); verify those by hand where an app relies on them.
- **A streamed database dump survives a hub restart or a stalled link.** The migrator now drains the dump client into a
  bounded on-disk spool (an anonymous Docker volume on the source host, removed with the migrator; `--dump-spool-mib`,
  default 8192) so a paused upload no longer trips MariaDB/MySQL's write timeout ("Lost connection to server during
  query"). A failed or diverged volume run releases its lease at once, so the printed remedy (`--reset-volume`, a rerun)
  works without waiting, and a failed dump reports the client's own error.
- **Container health no longer fails every minute on a server with no containers.**
- **Guided migrations for real multi-host Coolify fleets.** A run can now span several source servers: a server map
  places each source server on a Tugra server, an unmapped source server stops the run instead of landing on the
  default one, and the one-live-run-per-server rule and the typed point-of-no-return approval cover every target
  server. Runs can be grouped into campaigns, with a roll-up on the run list.
  - New `coolify-host-loop` source runner: the hub prints one script for the Coolify host that reaches each source host
    over Coolify's own per-server SSH keys, starts the migrator (and optionally the freeze) on each, resumes safely when
    re-run and reports per-host status. A host inventory compares `docker ps` and volumes with the Coolify API;
    unlisted database containers and orphan volumes block until the owner decides. Bind-mount sizes come from `du` and
    unmeasurable sizes are reported as unknown, never zero. Each host is probed for hub reachability and request-size
    caps.
  - Fail-closed owner policies: object-storage dependants (hold, mirror or external; default hold), an accepted write
    gap (default none), workers without a domain (held stopped until after the cutover by default), unlisted database
    containers and orphan volumes (default block).
  - The source Coolify version is recorded and checked: older than 4.1.2 blocks, newer than 4.7.5 asks for an
    acknowledgement.
  - Safety: the source's health is recorded before anything changes, so the post-cutover crash watch ignores apps that
    were already failing; push-to-deploy stays off until the point of no return; floating image tags are flagged and
    image apps are pinned to the digest the source runs; `earlyBuild` builds images before the freeze, and
    `deployConcurrency` caps builds per server.
  - Large databases: PostgreSQL, MariaDB and MySQL databases whose dump is over the 256 MiB artifact cap, or that cannot
    be copied as files (PostgreSQL 18 layouts, for example), stream through the relay as a dump with no size cap and
    are restored without spooling (opt in with large databases set to `stream-logical`). The lane is chosen from the
    measured dump size, and the downtime estimate includes it. New migrator flags `--measure-dbs`, `--measure-dump`
    and `--measure-dump-below`.
  - Import and env rewrite: services get private aliases and their hosts are flipped at cutover, Coolify custom
    `*.internal` aliases are carried, PostgreSQL copies can serve TLS when the source expected it, and cross-server
    references are reported for a manual fix instead of being rewritten to a name that cannot resolve.
  - Cutover: only hosts that depend on object storage are held back, one target server flips at a time, and manual DNS
    and the HTTP-01 gap are decided per host (an exact-record checklist, per-host confirmation, "leave this host out"),
    so one host the customer cannot change no longer stalls the run. The same-host proxy swap refuses the Coolify
    control plane's own box and takes the ports back if Coolify restarts its proxy. Git apps behind a moved host get a
    webhook-repoint warning.
  - Panel, CLI (`tugra import run create --map ...`, `--campaign`, policy flags, `command --kind`) and MCP surfaces
    for all of the above.
- **Migration lab.** `scripts/lab/` and the `Migration lab (vx)` workflow run the real Go migrator against a real
  hub, agent and the alpine busybox extractor (scenarios L0-L8: dry run, streaming, interrupt and resume, hub restart,
  tar fidelity, Postgres, memory, relay seats, throttling) plus fleet-shaped scenarios L9-L14 (multi-GB PostgreSQL 17
  and 18, MariaDB over the dump cap, a bind-mounted MinIO, running sources, Coolify 4.1.2 discovery, an Ubuntu 26.04
  userland). Nightly and on demand. Runbook:
  `docs/runbooks/migration-lab.md`.
- **Migrator memory.** Member buffers are allocated once and reused, and the Go heap limit is set below the
  container's memory limit so the garbage collector works before the kernel kills it. The migrator also reports source row and key
  counts during `--verify` and splits that report so a large fleet stays under the hub's request size limit. Two
  migrators on one docker host no longer remove each other's live helper containers at start.
- **The in-app updater applies releases that change the compose file or the installer scripts.** "Update now" no
  longer needs `git pull && ./scripts/install.sh` for those. Each release publishes its compose file and scripts with
  a separately signed per-file hash list, committed to by the signed update manifest (`hostFilesDigest`). The updater
  verifies the signature and every hash, checks that the scripts parse and the new compose is valid against your
  `.env`, backs up the files it replaces to `backups/host-files-*`, swaps them atomically, and restores them if the
  pull, recreate or health check fails. Your `.env` is never touched, and an images-only release takes a fast path.
  A release that changes services other than hub, web, agent and the updater, or needs a new `.env` setting, still
  asks for the installer. Your checkout needs one `git pull && ./scripts/install.sh` to gain this.
- **Swarm deploys survive a hub restart.** Queued deploys and deploys still building are re-queued and run once a
  cluster manager with a live agent connection is reachable (a backup manager is used when the primary is gone),
  and a rollout already handed to the manager is re-adopted from the agent's command journal, never re-sent,
  including Swarm's own auto-rollback outcome. Needs an agent that keeps the command journal.
- **Correct client IP behind proxies and Cloudflare.** The web server guards forwarded headers on the raw socket, so a
  client-supplied `X-Forwarded-For` or `CF-Connecting-IP` can no longer reach the hub. New opt-in Cloudflare mode
  (`HUB_TRUSTED_PROXY_CLOUDFLARE=true`, installer `--cloudflare-proxy`) uses `CF-Connecting-IP` only when the hop
  Traefik saw is a published Cloudflare edge range and fails closed otherwise. Refresh the vendored ranges with
  `node scripts/refresh-cloudflare-ips.mjs`, or add ranges with `HUB_TRUSTED_PROXY_CLOUDFLARE_EXTRA_CIDRS`. The web
  container now starts through `server.mjs` with `NODE_ENV=production`.
- **"Sign in with GitHub" works on the raw two-port install.** When web and hub are on different ports or hosts, the
  OAuth callback is served by the web origin at `/api/auth/oauth/github/callback`; open the panel at exactly
  `WEB_PUBLIC_URL`. Each login is bound to the browser that started it with a short-lived httpOnly state cookie.
  **Action needed** if you registered `<hub>/auth/oauth/github/callback` on a two-port or split-host install:
  register the web-origin URL, or set `GITHUB_OAUTH_CALLBACK_URL` to the old one. `--domain` installs are unchanged.
- MCP `import_plan`, `import_apply` and `import_mapping_resolve` accept `dbDataModes` (PostgreSQL physical volume
  copy), validated like the REST body.
- `tugra-cli` is versioned with the core, and CI fails if the two drift. `.env.example` documents the
  `TUGRA_TELEMETRY*` settings, `.nvmrc` is 22, and the README roadmap is current in all eight languages.

## [0.1.0-beta.17] - 2026-11-15

- **"Update now" shows what it is doing.** Settings → Updates has a four-step progress view (queued, pulling,
  recreating services, reconnecting and verifying the version) with an elapsed timer and the target version, and
  a Reload button once it finishes. "Check for updates" and saving the update settings now confirm with a toast.
- **No more raw "Failed to fetch" while the hub restarts.** A network failure or proxy 502/503/504 now reads
  "Hub is restarting or unreachable", an amber banner watches for the hub to answer and refreshes the page data,
  identical error toasts within two seconds show once, and the enroll-token re-issue and "Log out everywhere"
  buttons report failures instead of hanging.
- **Clicks now answer for apps, databases and the rest.** Volume Restore asks first, shows "Restoring…", locks every
  Restore button while it runs and toasts start and finish (it can no longer fire twice); backups, monitor checks,
  channel tests, swarm form/join/add-manager, license activation, environment moves and the tunnel and DNS-01
  switches end in a named toast; cutover Prepare, Check, Lower TTL and Finalize show a spinner and report counts;
  regenerating or removing a deploy key is confirmed and Copy says "Copied"; deleting a token, source, registry,
  credential, variable, saved view, project or team names what went; the Home sheet reuses the keyed Restart,
  Start and Stop toasts.
- **Updates reach beta testers.** Signed update checks are now on by default (hourly and whenever the panel is
  opened; `--no-update-checks` or `TUGRA_UPDATE_CHECKS=0` opts out, `UPDATE_CHECK_INTERVAL_MIN` tunes the interval),
  the release channel follows the running build (a beta hub tracks beta, shown as "Automatic (Beta)" in Settings →
  Updates; pin Stable or Beta to override, and an existing hub left on the old default switches to automatic), the
  card records when it last checked and why a check failed, and auto-update now applies the next beta of the same
  series as well as stable patch releases. Beta → stable and minor/major still wait for you. Hubs on beta.16 or
  older take this one upgrade manually (`git pull && ./scripts/install.sh`).
  The card also shows how often checks run and disables "Check for updates" with an explanation when checks are
  turned off for the deployment.
- **Restart, Start and Stop now say what they did.** A restart finishes with the app still "Running", so the
  click looked like nothing happened; each lifecycle action now ends in a named toast ("Gitea restarted.") or an
  error toast, never silence.
- **Server page actions now confirm themselves.** Proxy start, stop and restart end in a toast, network settings and
  proxy dynamic-config saves say "Saved", the Cloudflare Tunnel connect and disconnect show progress and a result,
  and the proxy refresh icon spins and has the right label. "Update agent" shows a restarting state until the new
  version reports in, then toasts it. OS patching toasts when an apply finishes (or fails), flags a pending reboot,
  and the per-package Update button shows its own loading state.
- **Sidebar footer is two short rows and the scrollbars follow the theme.** Sponsor is a small distinct pill,
  What's new and Documentation are icon buttons beside it, and Log out and Collapse share a row, so the
  navigation above keeps its room (five stacked rows before). Scrollbars everywhere are thin and tinted from the
  theme tokens instead of the browser's grey default.

## [0.1.0-beta.16] - 2026-11-15

- **Settings → Appearance: make the panel look the way you like.** A new tab holds per-user, browser-local choices:
  colour theme (Light, System, Dark, or Custom with Tugra Gold / Slate / Forest / Rose presets plus accent and
  surface-tint pickers), UI scale (80 / 90 / 100 %, always 100 % on phones), page width (Full or Centered),
  navigation style (Default or a Floating framed sidebar), a 3D or Flat style, and "Your time + UTC" for chart
  tooltips and deployment timestamps. Everything is applied before first paint, so a reload never flashes the defaults.
- **Deployments show progress and readable logs.** RUNNING and QUEUED deployment rows (list and detail header) now
  carry a spinning icon, and build/deploy logs tint ERROR and WARN lines the same way the live container logs do
  (the text is untouched, so copy still yields the original log).
- **Apps and Projects lists can be sorted, and tags filter.** A sort bar (name, status, project for apps; name,
  resources, created for projects) toggles direction on a second click and is keyboard-operable. Tag chips on the
  apps list are now buttons that filter the list to that tag (the app name remains the link into the app), and a
  project's environment resources get the same tag filter bar.
- **API tokens show expiry and can be renamed or rotated.** Each token lists when it expires, with an amber "N days
  left" badge at 14 days or fewer and an "Expired" badge once past; tokens can be renamed inline and rotated (the
  new secret is shown once, the old one stops immediately) from the existing endpoints, and the create form takes an
  optional expiry in days.
- **Patching warns before restarting the container engine.** When the pending updates include `docker-ce`,
  `containerd.io` or `runc`, the server's patching card says applying them restarts Docker and with it every app
  and database on that server.
- **"Disabled" is visible on scheduled tasks and per-volume backup policies.** Switched-off rows now carry a
  Disabled badge instead of relying on an unchecked box or muted text.
- **What's new, Documentation and Sponsor in the sidebar.** Three links above Log out: the GitHub release notes of
  the running version, the in-repo docs, and the sponsor page.
- **The running version is always in view, and the logo goes home.** The sidebar logo is now a link to the
  dashboard, and the running version (`v0.1.0-beta.N`) sits under the product name — in the logo's tooltip when
  the sidebar is collapsed. Every signed-in member sees it, not only the owner: a new session-guarded
  `GET /api/v1/instance/version` returns the version, channel and whether a newer release is published (no
  preferences, and nothing for anonymous visitors).
- **"Update available" is shown to every member.** The top-bar pill no longer hides from non-owners; for them it
  is a status whose tooltip says the instance owner applies updates from Settings, while the owner's pill still
  opens the Updates card.
- **App header: the Restart (and Start) icon is visible again.** The icon's amber/green tint was painted on the
  gold primary fill and vanished. A tinted icon now applies only on quiet (ghost) buttons; on a solid fill the
  icon keeps the fill's contrast colour.

## [0.1.0-beta.15] - 2026-11-15

- **Migrator: a volume-mode Postgres is no longer dumped by the database arm.** With `--arms all` the database row of a
  Postgres set to the physical volume copy is left to the volume arm (before, it was dumped, uploaded and refused by
  the hub on every run, or reported `not-running` and made the run exit partial). With `--arms databases` it is
  reported `skipped` with reason `volume-mode`; a hub refusal of the logical route now also reads `volume-mode`.
- **Cutover certificate seeding no longer overwrites a large target `acme.json`.** A target proxy store bigger than one
  agent command result (about 48 KiB) used to be read back cut off, treated as empty and replaced, losing the ACME
  account and every certificate already issued there. The store is now read in verified chunks (length and sha256
  checked, up to 2 MiB), and any truncated or inconsistent read stops the seed with nothing written; the proxy is still
  recreated.
- **Cutover: apps and databases moved by the streamed volume copy are no longer "stateful" forever.** The plan now
  counts a finished streamed volume copy (an app's volumes, or a volume-mode Postgres) as its data being moved, so the
  flip no longer demands the data-risk acknowledgement and keeps auto-revert for them.
- **Cutover certificate transfer: staged hosts come from the certificate itself.** The `sans` list sent by the
  migrator is no longer trusted or stored; the hosts of a staged certificate (and what gets written into the target's
  `acme.json`) are taken from the certificate's own names only, each checked as a valid hostname.
- **Import wizard: "Review & rename" now carries what you chose on the plan step.** Environment-variable acknowledgements,
  per-service choices (skip, rename, placement, volumes) and the PostgreSQL "Volume copy" modes were dropped when you
  continued into the review step, so acknowledged apps were skipped as blocked, a skipped service was imported anyway,
  and a plan with a Volume-copy database was refused as changed. They are now sent with both the preview and the apply,
  and Continue stays disabled while an acknowledgeable blocker is open or a service has no target, like the one-click
  apply. The mapping preview also treats an acknowledged item as importable (its project and environment are created
  and it lands there), the mapping hash now covers the acknowledgements, a plan hash no longer depends on the order the
  data modes were toggled in, and the MCP `import_apply` tool accepts `acks`.
- **Backup destinations: the encryption test no longer fails at random on a fresh agent.** The test's encrypt and
  decrypt gpg processes run at the same time and both tried to create the gpg home on first use; on an agent that had
  just started (or self-updated) one of them could die with `can't create directory '/root/.gnupg': File exists` and
  the destination showed an encryption failure. The gpg home is now created before the pair starts. Backup and
  restore scripts run a single gpg each, were never affected and are unchanged.
- **App moves: the preflight now measures the target host, not the agent's container.** Free space and the device id
  of the docker root (the daemon's real `DockerRootDir`) and of the staging disk are read through a throwaway
  container with the host path bound (the helper image, or the agent's own image when the helper is not on the host
  yet), so a target whose staging dir and docker root share one disk is sized with the shared-disk rule instead of the
  weaker two-disk one. Ports in use on the target are listed from the host's network namespace the same way (netstat,
  else `/proc/net/tcp`), so host listeners such as sshd, DNS or a host nginx now count in the port-conflict check and
  host-port reallocation; before, the list was always empty. If the ports cannot be listed the preflight fails with
  `probe_failed` instead of assuming none are in use. The probe still never pulls an image. Unknown device ids are
  sized as one shared disk (the stricter rule).
- **Changed (behaviour): Coolify imports are strict about environment variables.** The plan now reports, per app and by
  NAME only (never a value), the variables an import cannot carry: unresolved or unexpanded shared variables, Coolify
  magic variables, and names that are not valid environment keys. Each is a blocker you can acknowledge (per app, or
  all at once) to create the app WITHOUT those variables; until then the app is not imported. A Coolify API token that
  cannot read variable values (no `read:sensitive`) is one non-acknowledgeable blocker per app instead of silently
  importing apps with missing variables. Preview-environment variables are counted and listed as not imported. The apply
  request takes an optional `acks` list (existing API, CLI and MCP callers that omit it now see these blockers; the
  acknowledgement is the escape hatch). Dokploy and local imports are unchanged. An env value that still points at an old
  Coolify service host (for example MinIO) is now listed for review in the env-remap preview instead of staying silently
  unchanged.
- **Changed (behaviour): imported git apps are linked by repository visibility.** The old rule "link when the team has
  exactly one installed GitHub source" is gone: it could link an App that cannot see the repository. Each git app is now
  matched against the connected GitHub Apps (and Gitea/Forgejo/Codeberg tokens) that can actually see its repo, keyed by
  the repo URL host, so https repositories link too. Zero or several matches leave the app unlinked and listed (recoverable
  with Link now / `POST /import/operations/:opId/git-links/relink`). SSH repositories that a connected GitHub App covers are
  created as their https twin; the others keep their generated deploy key, whose public key is shown on the import
  timeline. New: `POST /import/git-links` (preview before apply), the "connect GitHub once, link N apps" panel, a `git.hosts`
  list in the import preflight (GitLab/Bitbucket hosts are reported as unsupported, never linked) and `tugra import git-links`.
- **Object migration (MinIO / S3).** New `Object migration` screens, API (`/object-migrations`) and `tugra objects` commands
  mirror buckets between two S3-compatible stores. The TARGET server's agent runs `mc mirror` in a detached helper
  container of its own image (the pinned, sha256-verified `mc` release is now vendored into the agent image; see NOTICE),
  so the data never passes through the hub. Seed is live and copies missing keys only; the final pass (after you stop the
  writers, with an explicit acknowledgement) overwrites changes, and deleting extra destination objects is off by default
  behind its own acknowledgement. Verification compares keys and sizes (`mc diff`); it is not a content-hash check.
  Object versions, IAM users and keys, replication, notifications, SSE keys and object lock are not carried.
- **Coolify services import as stopped compose apps.** Each Coolify service (Meilisearch, MinIO, Gotenberg, SigNoz,
  Beszel, cloudflared, your own compose stacks) becomes one stopped Tugra compose app built from the service's own compose
  file; nothing is deployed. Secrets are carried, never regenerated. Named volumes are declared (a host folder bind
  becomes a named volume), `container_name`, published ports and `coolify.*` / `traefik.*` labels are stripped and
  reported, members that need the Docker socket or other host access are dropped, and config files kept next to the
  compose become config mounts when the token can read them. The review screen shows a per-service verdict, members,
  volumes, domains and variable names (never values), with per-service choices, and the timeline ends with a post-import
  checklist. An internal-only service joins a private network under a stable alias: a new `PUT /apps/{id}/compose-networks`
  attaches a compose service to a hub-owned network (one additive migration). Service data is still copied by hand.
- **SSL/DNS cutover for imported apps.** A new cutover step in the import wizard (and `tugra import cutover <opId>`)
  moves each imported hostname through *certificate ready, DNS at source, switched, verified*: it checks the app
  through the Tugra proxy (Host header + SNI at the server IP), switches Cloudflare records in paced batches
  (5 hosts, 30 s apart, target TTL 60 s, proxied kept, SSL mode checked) with a rollback ledger, verifies after the
  switch and reverts only on request (auto-revert is off). Coolify-generated hostnames and tunnel-routed hosts are
  excluded/blocked, a stateful app needs an explicit `acceptDataRisk`, and the steps to stop the source app are
  printed (the Coolify token is read-only). It does not promise zero downtime; see `docs/runbooks/cutover.md`.
- **Per-host DNS-01 for custom domains.** A new app domain option issues the certificate with DNS-01 per host (no
  wildcard) so it exists before DNS points at the server. A server can reuse a team Cloudflare DNS credential for its
  DNS-01 resolver (`tugra servers dns-credential`); the token is copied, so re-apply it after rotating the credential.
  Existing apps' deploys and labels are unchanged.
- **Opt-in `--certs` for the migrator.** `migrate --certs` also copies the source proxy's ACME certificates for the
  op's hostnames (private keys travel to the hub, are encrypted at rest and purged after they are applied to the
  target proxy's own `acme.json`; the ACME account key is never sent). Off by default.
- **Dependencies.** The glob override moved to 14 (minimatch 11), clearing two dev-tooling advisories (minimatch
  GHSA-g3hv-75wg-m249, glob GHSA-3g3m-2fjr-6pw4). The vite lock was refreshed to 8.3.8. No runtime behaviour change.
- **Updater.** The pre-update restore point now refuses to start when the backup directory clearly lacks free space for
  the dump (nothing is changed).
- **Security.** X-Forwarded-For entries from a trusted proxy are now validated as IP addresses (a malformed value is no
  longer recorded as the client IP or matched against the allowlist). New opt-in `HUB_TRUSTED_PROXY_STRICT=true` trusts
  only `HUB_TRUSTED_PROXY_CIDRS` peers; off by default.

- **Streamed volume copy for the Coolify/Dokploy migration.** The one-click migrator has a volume arm
  (`--arms volumes|all`) that copies a stopped source container's declared volumes to the target in resumable ~128 MiB
  parts through the hub's memory relay: no size cap, no hub disk, owner/group/mode preserved, resumable by part (a
  changed source is `volume-diverged`, never overwritten), `--dry-run` inventory with the target's free space,
  `--stop-source` (only that container, restarted on failure), `--speedtest-mib` (measures the real link before a window is chosen) and explicit `volume-not-migrated` exclusions. A
  PostgreSQL database can opt into a physical **Volume copy** data mode behind strict gates (same image and major,
  credentials carried, data at the volume root, never-started destination); the dry run reports the image, major and
  mount so the answer is known before any window. New Import wizard panel, `tugra import volumes`, hub env
  `MIGRATION_VX_*`, `MIGRATION_RELAY_CONCURRENCY` and `MIGRATION_TOKEN_MAX_LIFE_HOURS`. Limits: one hub, device nodes
  refuse the copy, xattrs/ACLs/capabilities/sockets are not copied, compose/service volumes are out of scope. The
  existing database dump path, the hub-staged upload and app moves behave as before; the migrator image installer
  now sets `TUGRA_SELF_IMAGE` and caps a volume run at 768 MiB.

- **Dokploy in the Import wizard.** The wizard has a source picker (Coolify or Dokploy); the URL, key and hint
  wording follow the source, and the same source is used to connect, preview and apply.
- **The import preview lists what is not carried over.** Per app, a collapsed "What isn't carried over" list names the
  fields the source has that Tugra does not carry (field names and fixed reasons, never values), including a warning
  when a Coolify app was gated by HTTP basic auth, which now imports ungated. The apply timeline shows what each app
  could not carry and what was applied.
- **Changed (behaviour, new imports only): Coolify imports carry custom container labels and the inline Dockerfile.**
  Coolify imports now carry the app's custom container labels (labels in reserved namespaces such as `traefik.*` are
  dropped and named in the timeline; a dropped access-control middleware label is flagged for review) and, for
  Dockerfile apps with a repository, the inline Dockerfile text. It affects only new import operations: apps that were
  already imported and existing rows are never rewritten (the executor skips DONE tasks). Imported apps are created
  with `deploy:false`, so labels and the Dockerfile take effect only at the first deploy. Each setter is best-effort:
  a failure is reported on the task, never thrown. The token hint now notes that labels and Dockerfile text are read
  at apply time (needs `read:sensitive`).

- **Rotate the secrets encryption key from Settings without restarting the hub** (data keys wrapped by `SECRETS_ENCRYPTION_KEY`). Existing installs are unchanged until an owner rotates. Settings → Instance → Secrets encryption key → **Rotate key** makes a new random data key active immediately (no `.env` edit, no restart), starts the re-encrypt job by default, and lists every key with how many secrets it still protects; a replaced key can be **retired** once nothing uses it and **restored** later. The data keys live in Postgres only wrapped under your `.env` passphrase, so a database dump alone still decrypts nothing, and `SECRETS_ENCRYPTION_KEY` stays the root of trust (it is not rotated by this; two-factor recovery codes, hub-backup `.gpg` files and file-transfer / import signatures still follow it). This supersedes the "(the hub restarts twice)" description of the earlier rotation for data keys; changing the `.env` passphrase itself is still the manual restart flow, and the hub now re-wraps its data keys under the new passphrase automatically at boot. New owner-only endpoints `POST /instance/secrets-key/rotate`, `POST /instance/secrets-key/keys/{keyId}/retire` and `.../restore`; `GET /instance/secrets-key` gains the key list (additive).
- **Rollback caveat for rotated keys.** After the first rotation, a Tugra release that predates the key ring cannot read values stored under a data key. Before rolling back to an older release (or relying on `update.sh` recovery across such a version), use **Back to .env key** on the same card and let the re-encrypt finish (the card then shows the downgrade is safe).
- **Changed (behaviour): post-cutover soak is on by default for new apps.** New apps now default to a 30-second post-cutover soak on zero-downtime rolling deploys: the previous version is kept for 30 s and restored automatically if the new one fails 3 health checks in a row. Existing apps are unchanged (still off unless you set it); set 0 in Deploy settings to turn it off. Imported apps count as new. PR previews and compose/swarm apps are excluded. Each eligible deploy, and each fleet-rollout wave per app, takes about 30 s longer and holds the app's deploy slot for that time; a revert restarts the previous container (brief downtime). A soak-enabled app's first deploy no longer waits out the window.

- **Changed (behaviour): backup destinations are encrypted by default.** `POST /backup-destinations` (and the CLI and
  MCP tools that call it) without `encryptionEnabled` now creates an AES-256 (gpg symmetric) encrypted destination, S3
  or LOCAL. Send `encryptionEnabled: false` to opt out; an explicit `false` is honoured and audited as unencrypted. The
  web form already defaulted on. Existing destinations are unchanged. The implicit "server disk" path (no destination
  chosen) is still unencrypted.
- **Changed (behaviour): the create response carries a one-time `recoveryKey`.** The plaintext data key is returned
  exactly once, by the create call (`Cache-Control: no-store`), and is never returned by `GET`, never logged and never
  audited. The web app shows it in a "save this key" dialog with copy and download.
- **Changed (behaviour): deleting an encrypted destination is guarded.** `DELETE /backup-destinations/{id}` returns 409
  while the destination still has successful database, volume or base backups, because deleting it destroys the key
  they need; pass `?discardBackups=true` to confirm. Deleting a destination now also clears the app volume-backup and
  hub-backup pointers (it already cleared databases), in one transaction.
- **Changed (behaviour): an enabled volume schedule needs an interval or a cron.** `PUT /apps/{id}/volume-backups/config`
  with `enabled: true` and neither now returns 400 instead of silently never running. The destination must belong to the
  app's team. Existing stored schedules are untouched.
- **Fixed: LOCAL-type encrypted destinations stored volume backups in cleartext.** Volume backups resolved a LOCAL
  destination without its encryption settings. Backups now go through one shared destination resolver (also used by
  database and hub backups) that fails closed when encryption is on but the key is missing, never running gpg with an
  empty passphrase. Volume restore decides decryption by the `.gpg` suffix, so cleartext backups written before the fix
  keep restoring, and an encrypted LOCAL volume backup is written to a `.part` file and renamed.
- **Fixed: a missing gpg on the backup host is now an explicit failure.** Encrypted backup and restore scripts check for
  gpg first and fail with `TUGRA_GPG_MISSING` (exit 5), which becomes the backup's error message and the failure
  notification, instead of an opaque pipe error.
- **Added: cron schedules and age/size retention.** Volume backups and the hub backup accept a 5-field cron (at most
  hourly), `retentionDays` and `maxSizeGb`; database logical backups accept `maxSizeGb`. Prune removes whatever exceeds
  the keep-N count, the age, or the total size (oldest first, sizes in GiB), always keeps the newest backup of each
  volume, and logs when only protected backups remain over budget. Base backups and WAL stay under the existing
  WAL-aware cleanup, and objects whose remote delete failed are not counted.
- **Added: per-volume backup policies.** `PUT` and `DELETE /apps/{id}/volume-backups/policies/{volumeName}` give one
  volume its own cron or interval, switch it off, or override retention. The app-wide job skips such volumes, the
  missing-backup watchdog alerts per policy volume, and cloning an app copies its policies (inert until volume backups
  are enabled on the clone). `GET /apps/{id}/volume-backups/config` returns the schedule, policies, next run and storage
  usage per size pool.
- **Added: schedule preview and encryption-key export.** `GET /backup-schedules/preview?cron=` shows the next runs (in
  the hub's timezone) and the shortest gap. The instance owner can download every encrypted destination's key in a
  sealed file (`POST /instance/backup/destination-keys/export`, opens with `openssl enc -d -aes-256-cbc -pbkdf2 -iter
  600000 -md sha256`), and `scripts/hub-migrate.sh pack` now includes `destination-keys.json` (mode 600) when hub-api is
  running. The destination test also round-trips a canary through gpg with the stored key.

- **Move an app to another server.** An app can be relocated, with its data, to another server of the same team
  (app Settings, General, **Move to server**). It keeps its identity: the same app ID, settings, secrets, webhooks,
  scheduled tasks and history. The dialog runs a read-only preflight on both servers (disk space, tools, ports,
  aliases, volumes, GPU and CPU fit, DNS and domain consequences, an optional real link-speed test), asks you to
  acknowledge each consequence, and starts the move after you type the app name. The app is stopped on the old server
  (checked, not assumed), each volume is packed, sent through the hub in bounded parts (verified by size and SHA-256 at
  both ends, retried per part) and unpacked on the new server with ownership preserved, the app is switched to the new
  server in one database transaction, deployed there, and the old container is removed. The old server keeps a stopped
  copy of the data for the archive period you choose (default 7 days; **Remove old copy now** and an hourly sweeper
  purge it, guarded when the app lives there again). Any failure before the switch leaves the app untouched on the old
  server and restarts it; a failed deploy on the new server restores the app (server, generated domain, host port,
  log drains) from a snapshot and restarts the old copy. A hub restart at any point ends with the app on exactly one
  server (rolled back before the switch, completed or rolled back after it). The move shows live progress and a cancel
  button on the app page until the switch; completion, rollback and failure fire the `app_move_completed`,
  `app_move_rolled_back` and `app_move_failed` notifications. New endpoints `POST /apps/{id}/move/preflight`,
  `POST /apps/{id}/move`, `GET /apps/{id}/moves`, `GET /apps/{id}/moves/{moveId}`, `POST /apps/{id}/moves/{moveId}/cancel`
  and `POST /apps/{id}/moves/{moveId}/purge-source`; `AppView.move` is additive. Swarm/cluster apps, apps with previews or
  linked managed databases, and apps with an active rollout or deploy are refused.
- **Agent: `hub_origin_env_v1`.** The agent exports `TUGRA_HUB_ORIGIN` (derived from its own configured hub URL, never
  from the hub's message) to `backup`-capability commands only, so a hub-built script can reach a signed relay path.
  Update agents before moving an app; an agent that cannot update itself cleanly has to be moved by hand once
  (the preflight reports `agent_too_old`). New hub settings `MOVE_PART_MIB` (default 256, clamped 32 to 1024) and
  `MOVE_MAX_CONCURRENT_RELAYS` (default 2); lower `MOVE_PART_MIB` when a proxy in front of the hub caps request bodies.
  Route `/api/v1/agent-vx/` straight to the hub, like `/api/v1/agent-fs/`.
- **Changed (behaviour, only while or after a move).** While an app is being moved these return 409
  `app_move_in_progress`: config edits, start, stop, restart, delete, rollback, restoring a volume backup, importing a
  volume, creating or deleting a database link, and file-manager writes and moves of volume files. Manual volume
  backups of the app are refused the same way and scheduled ones skip that tick. A pull-request preview webhook is
  skipped and audited as `preview.skipped` (reason `app-move-in-progress`). Deploys keep queueing but wait until the
  move ends (a deploy that is already running when the move starts is waited out for up to 10 minutes, then the move
  rolls back with the app untouched). `Idempotency-Key` values starting with `move:` are reserved and return 400 for
  every client, like `rollout:`; the move's own deploys use them and are exempt from the per-app queue cap.
  Deployments gain a nullable `runServerId` and the `move` trigger (additive). After a move, a rollback target that only
  exists as a local image tag on the previous server returns 409 `rollback_predates_move` (registry and digest-pinned
  deployments are unaffected); restoring a LOCAL volume backup made on a previous server returns 409
  `backup_on_other_server`; deleting a server is refused (409 `server_in_active_move`) while it is part of a move or
  still holds a move's archived data. Deleting an app best-effort removes the old server's archive too, unless you chose
  to keep its volumes: then the archive stays and the hourly sweeper removes it after the archive period. A move is also
  refused while a migration import is still filling the app (`migration_import_active`). When a move fails and the app
  cannot be restarted on the old server it stays flagged as needing attention (with a critical notification) until you
  clear it with **Remove old copy now**, which never removes data that is live on the new server. If an unpacking step
  could not be undone cleanly, the replaced data is kept on the new server as a recovery volume (shown on the move card)
  until you remove it with that same button. Nothing is on by default: the migration adds one table and two nullable
  columns, existing rows are untouched.
- **Known limits of app moves.** Downtime equals the copy time (a cold move; no incremental sync). Extended attributes,
  ACLs and sparse files are not preserved. The copy is unpacked by the BusyBox `tar` of the pinned helper image
  (`alpine:3.21`): every regular file's content, mode, owner and modification time, directory modes and owners, hard
  links and symlink targets are restored exactly, but the owner of a symlink itself (it comes out `root:root`) and the
  modification times of non-empty directories and of symlinks are not (they read as the unpack time). Exactly the same
  limit applies to volume backup restores and volume imports, which use the same helper; a database does not care,
  an mtime-based cache in front of a web root may. Follow-up: a helper with GNU tar would lift it. Host bind-mount data and compose `external:` / `name:` volumes are not
  transferred (each needs an acknowledgement). Metrics and traffic history split at the move. The move deploy uses the
  configured tag or commit, so a mutable `latest` or a branch may resolve to something newer. Managed databases,
  swarm apps, previews and the CLI/MCP surface are out of scope for now. A fronting proxy that caps request bodies below
  `MOVE_PART_MIB` makes the transfer fail cleanly (the app is restored); the link test only detects limits up to 16 MiB.
  A compose app whose YAML publishes fixed ports cannot have them checked for conflicts on the new server (only
  template-installed ports are), so a clash surfaces as a failed deploy and a rollback.

## [0.1.0-beta.14] - 2026-11-15

- **Container labels.** The app's Configuration tab has a **Container labels** card. It lists, read-only, every label
  Tugra applies (Traefik routing, the proxy-network pin, the stable alias, compose config fingerprints; basic-auth
  hashes and the forward-auth address are hidden), built by the same code that writes the deploy scripts, and lets
  you add your own container labels on classic docker-run and swarm apps, with a paste helper for `KEY=VALUE`
  lines and a **Reset to defaults** button. Changes apply on the next deploy. On a swarm they are container labels
  set through a rolling update, and removing or resetting them strips the old ones on the next deploy. Compose apps
  declare their own labels in the compose file, and previews do not take custom labels (previews do not inherit
  them from their parent). Keys in the `traefik.`, `tugra.`, `com.docker.compose.`, `com.docker.swarm.` and
  `com.docker.stack.` namespaces are reserved, and a key set both here and as `--label` in Custom Docker options is
  refused. Cloning an app copies its custom labels. The deployment diff shows `customLabel.<key>` changes without
  the values. New endpoints `PUT /apps/{id}/custom-labels` and `GET /apps/{id}/labels`, and `tugra apps labels
  ls|set|rm|reset`.
- **Changed (behaviour): Custom Docker options reject more label namespaces.** `--label` keys in `tugra.*` and
  `com.docker.compose.*`, `com.docker.swarm.*` and `com.docker.stack.*` are refused in addition to `traefik.*` (a
  `tugra.role` label could make Tugra's own cleanup remove the app's container, and a `com.docker.compose.project`
  label could spoof compose lookups). An app that already stores such a label fails its next deploy or rollback with
  a message naming the label; the running container is not touched.
- **Changed (behaviour): compose files may not set Tugra's labels or join its networks.** A compose file (pasted,
  from a template override, or cloned from git) with `traefik.*`, `tugra.*` or `com.docker.compose|swarm|stack.*`
  labels on a service (or in `deploy.labels`), or an external network named `tugra-*` / `tugra_*` (for example
  `tugra-proxy`), is rejected when it is saved and on the next git deploy. Such a label could declare a route for
  another team's hostname, and the network lets a service answer for every tenant's routes.
- **Changed:** the config snapshot records a fingerprint of each custom label value.
- **Changed (behaviour): a pasted compose file may not build reserved names through variables.** `${VAR}` / `$VAR` in
  a label key (`"${P:-traefik.}http.routers.x.rule=..."`), in `container_name`, or in a top-level network `name` is
  rejected when the compose is saved, because compose substitutes it only at deploy time and the reserved-namespace
  checks would never see the result; label values keep working with variables. `label_file`, and a service
  `env_file` that points at a sensitive host path, outside the compose directory or through a variable, are rejected
  too, and the compose preview returns a fixed error message instead of the raw `docker compose` output.
- **Compose deploy hooks:** the pre-deploy one-off container is started with `traefik.enable=false`, so it can no
  longer register as a Traefik backend of the live router during a deploy. The post-deploy hook (`exec` in the
  running container) is unchanged.
- **Custom label values** are hidden from API tokens without `read:secrets` (`customLabels` on the app view, and
  `GET /apps/{id}/labels` now needs that scope).
- **Log drains: fixes.** Drain pushes to one server are serialized, so an older drain set can no longer reach the
  agent with a newer revision. The agent bounds the total size of a fluentd acknowledgement or handshake reply, retries
  a connection that drops during the fluentd handshake (instead of reporting a configuration error), reports a sink
  that requires user authentication as such, stops an in-flight HTTP delivery when the drain is removed or `logs` is
  revoked, and counts GELF messages it cannot send as dropped and syslog lines cut to the size limit as truncated.
  Changing a drain's type in the edit form clears its stored token. Old custom-named image tags stay reclaimable
  after the image name is cleared.

- **Custom pushed image name and an alias tag.** On an Image or Git app that pushes to a team registry, **Build &
  registry** now takes an **Image name** (a repository path under the registry namespace, for example `team/web`;
  empty keeps `tugra_<app id>`) and an optional **Alias tag** template (`latest`, `{branch}`, `{branch}-{sha}`;
  `{sha}` is the first 12 characters of the built commit and, like `{branch}`, is for Git apps only). The immutable
  `:<deployment id>` tag is always pushed and is still what the deployment records and what a rollback pulls; the
  alias is an extra, registry-side tag that moves on every build (last built, not last deployed), and a rollback
  does not move it. A registry that enforces immutable tags rejects the alias and the deploy fails before the swap
  with the old version still serving; clear the alias tag for such a registry. An alias can never take a
  deployment-id shape, and a name can never start with `tugra_` (reserved for default repositories). A repository can
  belong to one app per registry (a clash returns 409), and clearing the registry or push clears the name and alias.
  `PUT /apps/{id}/build-config` takes `pushImageName` and `pushImageTag` (undefined keeps, null clears); both are
  returned on the app view and recorded in the deployment's config snapshot. Cloning an app no longer shares them:
  the clone pushes to its own default repository, because a copied name would be rejected by the unique index and a
  copied alias would let two apps race on one tag.

- **Fixed: cleanup of pushed local image tags is anchored on the app's own deployment ids.** Removing the local copy
  of a pushed image (a failed or cancelled deploy, adoption, keep-N pruning) used to match only the
  `tugra_<app id>:` namespace; with a custom repository name it now also accepts a tag whose version is one of the
  app's own deployment ids, and never any other image. Apps without a custom name run the same cleanup as before.

- **Pre/post-deploy commands for Compose apps.** The **Pre/post-deploy commands** card now appears on single-server
  Compose apps with a service picker (a dropdown for a pasted compose file; a text field plus **Detect services**
  for a git-sourced one). The pre-deploy command runs in a one-off container of that service after its image is
  pulled or built and before the stack is brought up; a failure fails the deploy with the current stack still
  serving. It does not use `--no-deps`: the service's dependencies are started first so a migration can reach its
  database, including on the first deploy, and if the command fails those dependencies keep running (the service
  itself is never recreated). The post-deploy command runs with `compose exec` once the service is running (and
  healthy, when it has a health check) and is best-effort: a failure is logged and never fails the deploy. Both are
  part of the one durable deploy command, so a hub restart recovers them with the deploy, and a rollback runs
  neither. The service must exist in the compose file: a pasted file is checked when the hooks are saved and when the
  file is edited (a file that drops the hooked service is refused); a git-sourced file is checked against the
  rendered stack at deploy time. `PUT /apps/{id}/deploy-hooks` takes `composeHookService`. Apps without hooks deploy
  exactly as before.

- **Resolved compose preview.** Compose apps (pasted or from git) get a **Preview resolved compose** button that
  shows the file as Compose resolves it (anchors, `extends`, normalisation) via `POST /apps/{id}/compose-preview`
  (scope `read:secrets`, apps:config). The agent runs `docker compose config --no-interpolate`, so `${VAR}`
  references are shown unresolved and no environment value is sent to the agent; literal `environment` and
  build-argument values are replaced with `<redacted>` on the hub, as is any of the app's environment values found
  elsewhere in the file. The preview never touches the running stack's files (a git preview clones into a private
  temporary directory that is removed afterwards), is not cached, and is not exposed through MCP. It needs a Docker
  Compose that supports `--no-interpolate` on the agent (422 otherwise), and the Tugra routing override added at
  deploy is not shown.

- **Inline Dockerfile for Dockerfile builds.** A Git app built with a Dockerfile can store the Dockerfile text on
  the app (**Dockerfile source: Inline**, up to 48 KiB, must start with `FROM` after any `ARG`s) instead of using
  the repository's file. It is passed with `docker build -f` from a path outside the clone, so the repository is
  still the build context (`COPY` paths resolve against it and its `.dockerignore` applies). It is not a repository-free
  app; the Dockerfile path stays stored and is used again when the inline text is cleared. The text is visible only to
  members who can edit the app, is never part of the config snapshot or MCP results (only its size and a
  fingerprint), and is copied by clone and by PR previews. `PUT /apps/{id}/build` takes `inlineDockerfile`.

- **File manager: upload, edit, rename, permissions and delete on app volumes.** A new opt-in server capability,
  `files_write`, adds write access next to the existing read-only `files` (it requires `files`; the web capabilities
  card unchecks it when you uncheck `files`). With it, an app's **Files** tab can upload files (multi-select or drag
  and drop, two at a time, with progress, cancel and retry; a file that already exists asks Overwrite or Skip),
  create folders and files, edit text files up to 1 MiB in place (a concurrent change shows Reload or Overwrite
  anyway), download, rename, change permissions (an rwx grid kept in sync with the octal value; setuid, setgid and
  sticky bits cannot be set) and delete (a folder is a recursive delete and asks you to type its name). Writes run in
  a short-lived, network-less helper container with only that one volume mounted read-write and only the CHOWN,
  DAC_OVERRIDE and FOWNER capabilities; new files get the owner of the folder they land in, so the app user can read
  them, and an overwrite keeps the file's owner and mode. An upload is hashed by the hub, pulled by the agent over a
  single-use signed URL, written to a temporary file in the same folder and renamed into place, so an interrupted or
  tampered upload leaves nothing behind. Symbolic links are never followed or written through. Every change is
  audited with its path and shape, never its content: a change that was dispatched and then failed leaves an
  `app.file.failed` row, and a request refused before dispatch (policy, capability, path, rate limit) leaves an
  `app.file.denied` row with its path and reason code (a busy server leaves none). Changes are paused while a deploy is queued or running, and writing into a running
  database or broker volume (detected from its image or template) needs an explicit acknowledgement. API: `GET /apps/{id}/files/meta`,
  `GET /apps/{id}/files/stat`, `GET|PUT /apps/{id}/files/content`, `POST /apps/{id}/files/mkdir|rename|chmod` and
  `DELETE /apps/{id}/files`; a token needs `write` and `read:secrets` for writes and `admin` for delete. Needs an
  agent that advertises `fs2_v1` (update the agent first; older agents answer `agent_too_old`). `fs2_v1` is a new
  signed, expiring, replay-protected agent message; the legacy list request is unchanged.

- **`files` now also covers file content.** The existing `files` capability used to allow only directory listings.
  It now also allows stat and downloading a file's content (`read:secrets` for tokens), still through the read-only
  helper. Grant it only where you are comfortable with writers of the team reading that application data.

- **`files` can be granted from the web.** The server capabilities card now lists **Files** and **File changes**;
  `files` was previously settable only through the API.

- **Container filesystem browser and editor.** For users with the `terminal` team permission on a server that has
  the `files`, `files_write` and `terminal` capabilities, an app's Files tab gains a **Container (ephemeral)**
  source: browse, download, replace and upload files in the running container (for example `/app` and `/etc`), with
  an editable path field and quick links. It works through `docker cp`, so it also works on stopped and distroless
  containers. Reads, writes and new folders are performed by the Docker daemon as container-root, so they ignore the
  image's `USER` and file modes and can reach files the container's own user could not; rename, permissions and delete
  run `mv`, `chmod` and `rm` inside the container as the image's default user and report `no_binary` when the image
  does not ship them. Changes are lost when the container is recreated, writes are not
  atomic, and a very large directory lists only its first part. Clustered apps are not supported. Every change needs
  the `admin` token scope. API: `GET /apps/{id}/container-files[/stat|/content]`, `PUT /apps/{id}/container-files/content`,
  `POST /apps/{id}/container-files/mkdir|rename|chmod`, `DELETE /apps/{id}/container-files`.

- **Large uploads through the web origin.** The web server's generic `/api/v1` rewrite buffered request bodies in
  memory and cut them at 10 MiB, so a larger upload hung. File uploads and the agent transfer URLs now stream
  through dedicated routes with real backpressure, and the generic proxy is a fallback rewrite. An upload that trickles in below a minimum
  throughput is cancelled, each user may have two uploads in flight per server, a busy server no longer burns the rate
  limit or audit log, a deploy that starts while a body is being received pauses the write, and the web hop to the hub
  idles out after 11 minutes (`HUB_PROXY_TIMEOUT_MS`) instead of fetch's 5.

- **Agent toolchain.** The agent now builds with Go 1.25 (the file helper needs `os.Root` operations that arrived in
  that release). Overwriting a file replaces its inode, so hard links, extended attributes and ACLs of the old file
  are not carried over.

- **GPU detection.** A server's page has a **Detected GPUs** card: GPUs found on the PCI bus, the NVIDIA driver
  and the Docker `nvidia` runtime, and one verdict (ready, driver missing, runtime missing, non-NVIDIA, none, probe
  failed). The result is stored per server, so read-only members see the last snapshot; a member with the
  `servers:ops` permission refreshes an unknown or stale one automatically and can re-run detection with a button
  (`GET /servers/{id}/gpus`, `POST /servers/{id}/gpus/refresh`, capability `bulk`). The probe is a fixed script
  that starts an unprivileged `nvidia-smi` helper container from the agent image (no network, read-only, `--pull
  never`) under its own timeout. BMC and hypervisor display adapters (ASPEED, Matrox, VMware, virtio, QEMU, Hyper-V
  and similar) are listed as virtual displays, not as GPUs. On an app's **Resources** card the GPUs field now shows
  what was detected on its server, one-click values (`all`, a count, `device=<index or UUID>`) and a soft warning
  when the value does not match; it never blocks saving. Cloning an app that requests GPUs to a server with no
  detected NVIDIA GPU keeps the setting and warns. Servers that were never checked read "Not checked yet", never
  "no GPU".

- **Pull request previews from GitLab, Gitea, Forgejo and Bitbucket.** The per-app webhook now recognises
  merge/pull-request events from GitLab, Gitea, Forgejo and Bitbucket (Cloud and Server) as well as GitHub, by
  their own event headers, and creates, updates and removes the preview like the GitHub path. Responses carry a
  `reason` (shown in the provider's delivery log) when nothing happens. Behaviour changes: pull requests from a
  fork (or with an unknown head repository) are now ignored on every provider, including GitHub, because the
  preview builds a branch of the parent repository with the parent's environment and credentials; previews are
  created only for Git-built apps (a close event still removes an existing preview); for non-GitHub providers the
  event's repository must match the app's repository; a Bitbucket "updated" event rebuilds only when the head
  commit changed. Push webhooks are unchanged.

- **Image update check for Image apps.** An app deployed from a registry image now shows whether its tag has a newer
  image upstream: an **Image updates** card on the overview (Up to date, A newer image is available, Pinned,
  Redeploy once to record the digest, and so on), an **Update available** badge, and a **Pull & redeploy** button for
  members who can deploy. The server the app runs on asks the registry for the tag's manifest digest (the hub never
  contacts a registry) and compares it with the digest recorded at the last successful deploy; credentials stored
  on the app are used. Apps are checked every `IMAGE_UPDATE_CHECK_INTERVAL_MIN` minutes (default 360, `0` turns the
  feature off for the whole hub) and again after each deploy; repeated failures back off to once a day.
  `POST /apps/{id}/image-update-check` checks now (deploy permission, throttled to one probe per 30 seconds) and
  `PUT /apps/{id}/image-update-check` turns it off or on for one app. A new notification event,
  `image_update_available`, fires once per new upstream digest; the first check after an upgrade only records the
  baseline, so upgrading produces no notifications. Digest-pinned references are never checked, and editing the tag
  shows no verdict until the next deploy. The app view also gains `canDeploy` and the server view `canOps`, so the
  UI can hide actions the API would refuse.

- **Per-variable environment flags.** Each variable of an Image, Git or Compose app can now be marked
  **Build time** (Git apps: passed to the image build as `--build-arg` / builder `--env`; with **Available at runtime**
  off it is build-only and never reaches the running container), **Literal** (Compose: the value is not expanded,
  `$VAR` and `${VAR}` stay as written; other app types already pass values literally) and **Multiline** (PEM keys,
  JSON). `PUT /apps/{id}/env` takes an optional `flags` object (omitted keeps the stored flags, present replaces
  them; the body is now strict, so unknown fields return 400), `POST /apps` takes `envFlags`, and
  `GET /apps/{id}/env-flags` returns the stored flags. Multiline (and, on Compose, Literal) values are delivered by
  name through the Docker CLI's own environment (`env KEY=... docker ...`): they are never written to the env file
  and never a docker argument (the base64 payload is part of the deploy script, which travels as one `bash -c`
  argument, like the other tokens in it). On Swarm they are decoded inside the container, which needs a shell and
  `base64` in the image; the deploy fails with a clear error otherwise rather than falling back to plain env. The
  name of a multiline or Compose-literal variable must be a plain identifier and must not be one that changes how
  Docker runs: `PATH`, `HOME`, `TMPDIR`, `LD_*`, `DYLD_*`, `DOCKER_*`, `COMPOSE_*`, `BUILDKIT_*`, `BUILDX_*`,
  `XDG_*`, `*_PROXY`, `SSL_CERT_FILE`/`SSL_CERT_DIR`, shell-special names such as `UID`, `RANDOM` or `BASH*`, and a
  short list of ssh and git names that make a process run a program (`SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`,
  `GIT_ASKPASS`, `GIT_CONFIG_*` and similar); names such as `SSH_PRIVATE_KEY`, `GIT_DEPLOY_KEY`, `SSL_KEY` and
  `SSL_CERT` are accepted. Compose lifecycle commands (stop, start, restart, logs, remove and the final `ps` of a
  deploy) carry the same variables, and when every variable is moved out of the env file the previous plaintext file
  is removed. A deploy script that would exceed the one-argument size limit now fails up front with a clear error
  for multiline, build-time and Swarm deploys. Apps with no flags deploy exactly as before. Variables from a Vault
  secret reference cannot be build-time or build-only. The Coolify importer carries Coolify's four flags, imported
  and adopted values with line breaks are marked Multiline, and Dokploy build arguments map to Build time.

- **A line break in an environment value no longer corrupts the env file.** A value with a line break that is not
  marked Multiline - data stored before this release, or reachable through shared variables, the importer, MCP or
  the migrator - used to add extra variables to the env file. Saving such a value without the flag is refused (400).
  Values already stored that way keep deploying: at deploy and rollback time they are delivered as Multiline
  automatically (the deploy log lists `auto multiline: KEY`, nothing is rewritten); only a value whose name cannot be
  a multiline variable, that contains a NUL, or that exceeds 16 KiB fails the deploy, with an error naming the
  variable. The same fail-closed check now covers every env-file writer, so an empty, `=`, CR, LF or NUL in a key,
  or a line break in a DNS-challenge credential or a service variable, is refused with the credential named.
  DNS-challenge credentials are validated when saved (a single line per value, trailing whitespace trimmed) and
  already-stored ones with a trailing newline are trimmed when the proxy is rendered, so they keep working. Shared
  variables reject line breaks when saved.

- **Per-app log drains, container filter and syslog / GELF / fluentd targets.** An app's **Logs** tab has a **Log
  drains** card: a drain scoped to one app ships only that app's containers (its container, its rolling-deploy
  twin, compose services, swarm tasks on every member server), never other apps or databases. Compose apps that
  are not deployed to a swarm can narrow a drain to named services; a server-wide drain can narrow itself with
  container name patterns. New targets next to HTTP, Loki and Datadog: syslog (RFC 5424 over UDP, TCP or TLS),
  GELF 1.1 (UDP with gzip/zlib and chunking, TCP, TLS) and fluentd Forward (TCP or TLS, acknowledgements, optional
  shared-key handshake), all written without third-party libraries, with per-sink queues so a dead sink never
  stalls the others. Each drain shows a delivery state (delivering, waiting, agent offline, agent update required,
  failing with a failure class, and so on) from the agent's own reports, and a server's **Log drains** tab lists the
  app drains shipping from it (name, type, app, delivery; never the endpoint). Egress is restricted: cloud metadata
  and link-local addresses are blocked for per-app drains and for server-wide syslog, GELF and fluentd drains
  (server-wide http, loki and datadog drains keep their previous unguarded reach), and per-app drains cannot reach loopback, private or CGNAT ranges
  unless **Allow private network targets** is set, which needs `servers:ops` on the app's server team in addition to
  `apps:config`. Drains travel to the agent in a signed `log_drains_v2` frame gated on the `logs` capability; an agent
  without it receives only plain server-wide http/loki/datadog drains (exactly as before) and shows **Agent update
  required** for the rest. Upgrade the hub first. See [Log drains](docs/log-drains.md) for the guarantees: delivery
  is best-effort and at-least-once, lines emitted while the agent is disconnected are lost, UDP cannot confirm
  delivery, boundary lines can repeat after a tail restart, a container using a log driver `docker logs` cannot
  read is not forwarded, and previews, clones, importers and config snapshots never include drains. Behaviour
  changes: server drain `PUT`/`DELETE` now return 404 when the URL's server id does not own the drain (it was
  ignored); http, loki and datadog endpoints written through create/update must be `http(s)` URLs (stored rows are
  not re-validated); on agents with `log_drains_v2`, revoking the `logs` capability now actually stops drain egress
  (`logs` is granted by default, so default setups are unaffected); the agent keys log tails by container id, reads
  stdout and stderr as separate streams and may reorder lines slightly inside a batch; the drain views gain
  additive keys (`scope`, `appId`, `containers`, `options`, `allowPrivate`, `delivery`, `status`).

- **Log drains: fixes.** A container that restarts quickly is tailed again (the old tail was never removed), a
  line longer than 1 MiB no longer stops its tail, and deleting an app re-pushes the drains of the servers it was
  shipping from.

## [0.1.0-beta.13] - 2026-11-15

- **No container-log stream before the first deploy.** The Logs tab of a never-deployed app no longer opens a
  `docker logs --follow` on a container that does not exist yet (it used to print "No such container" on every
  reconnect). The card says that container logs appear after the first deploy; `GET /apps/{id}/logs/stream` and
  `/logs/download` answer 409 for an app in the NEW state.

- **Cleanup options when deleting an app.** The delete dialog can also remove the app's custom Docker networks
  and prune dangling build cache. Networks are removed only if Tugra created them (they now carry a
  `tugra.managed=true` label), no other app on the server lists them and nothing is still attached; `tugra-proxy`,
  `tugra-net`, `tugra-apps` and networks you made by hand are never touched. Networks created before this release
  have no label (Docker cannot add one to an existing network) and are left in place. The build cache is
  host-wide, so it is pruned on the build server (or the app's server) and may make another app's next build
  slower. The API takes `pruneNetworks=1` and `pruneBuildCache=1` on `DELETE /apps/{id}`, and all four delete
  query parameters are now documented as optional.

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
