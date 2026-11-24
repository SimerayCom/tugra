# Install

Tugra runs as a small Docker Compose stack — hub (API), web UI, PostgreSQL, Redis, and an
update sidecar — that you bring up with a single script. This page is the authoritative
install reference; the [project README](../README.md) has the short version.

## Prerequisites

- A **Linux host** you control (amd64; arm64 works but builds from source — see below).
- **Docker** + the **Compose v2** plugin. The installer installs Docker for you if it's missing.
- `curl` (present on virtually every host); `git` is fetched by the installer if needed.

## Quick start

One line on the host. No domain, no Cloudflare token and no extra setup are needed. `tugra.io/install` serves [`scripts/bootstrap.sh`](../scripts/bootstrap.sh) from this repository, so you can read exactly what it runs:

```bash
curl -fsSL https://tugra.io/install | sh
```

The panel comes up on **`http://<server-ip>/`** (port 80), served by Tugra's own proxy with the same
single-origin routing a domain install uses, so only ports **80 and 443** have to be open in your firewall.
Create the owner account, then — when you have a domain — set it under **Settings → Instance → Panel
domain** (see [Set the domain later](#set-the-domain-later-settings--instance--panel-domain)).

With a domain from the start (point its DNS at the server first), pass it to the same command:

```bash
curl -fsSL https://tugra.io/install | sh -s -- --domain panel.example.com
```

(or clone first, then run the installer directly — same result:)

```bash
git clone https://github.com/SimerayCom/tugra.git && cd tugra && ./scripts/install.sh [--domain panel.example.com]
```

It prompts once to share anonymous usage stats (`[Y/n]`, default yes; opt out with `--no-telemetry`).
Run `./scripts/install.sh --help` for all flags (`--domain`, `--raw-ports`, `--home`, `--no-telemetry`, `--public-ip`, …).

The installer:

1. Generates strong secrets **once** into a local `.env` at `chmod 600` (re-running preserves them).
2. Brings up the hub, web UI, PostgreSQL and Redis with `docker compose` (the hub applies database
   migrations on boot).
3. Starts Tugra's own proxy (Traefik): without `--domain` it answers on `http://<server-ip>/`, with `--domain`
   it serves `https://<domain>` with a Let's Encrypt certificate. If port 80 is already used by another
   service, the installer says so and falls back to the classic raw ports (below).
4. Waits for the hub to become healthy and prints the **Web UI** and **Hub API** URLs.

A cloud server behind NAT reports a private interface address; pass `--public-ip <ip>` so the printed URL is the
reachable one. Open the web UI and create the first account — it becomes the instance
**owner**. On a fresh install the installer prints a one-time **setup code**; enter it when creating the
owner account (to recover it later: `grep SETUP_CODE .env`). Then follow the onboarding wizard to connect
your first server.

Published images (`ghcr.io/simeraycom/tugra-*`) are public and pulled automatically, so a normal install
is fast. If a pull can't be satisfied — an **arm64** host (the images are amd64-only) or an offline/mirror
environment — the installer builds from your checkout instead (same command; it takes several minutes and
wants ~2 GB RAM). Force either path with `--pull` or `--build`.

**Classic raw ports.** `--raw-ports` (or `TUGRA_RAW_PORTS=1`) skips the proxy and publishes the panel on the raw
ports instead — web UI `http://<host-ip>:3001`, hub/API `http://<host-ip>:3000`, as before. It is chosen
automatically when port 80 is taken, and an install made before this change keeps exactly the setup it has:
re-running the installer (the upgrade path) never moves an existing panel, and the existing `.env` values
(`HUB_PUBLIC_URL`, `WEB_PUBLIC_URL`, `HUB_PORT`, `WEB_PORT`, `HUB_BIND`, `WEB_BIND`) always win.

## Production: TLS + a domain

Tugra provisions the panel's HTTPS itself. You can give it the domain at install time (`--domain`) or later from
the panel; or you can bring your own proxy.

### Option A — automatic HTTPS (the default with `--domain`)

```bash
./scripts/install.sh --domain tugra.example.com
```

A bundled Traefik reverse proxy gets a Let's Encrypt certificate (**HTTP-01**) and path-routes the single origin
(table below). **No email and no Cloudflare token are required** — `--acme-email you@example.com` is only an
optional contact for expiry notices (a placeholder like `example.com` is rejected). The only outbound call is to
Let's Encrypt for *your* domain — no phone-home. Point the domain's DNS at this host first; the certificate issues
as soon as `:80` is reachable. Before it provisions, the installer sanity-checks the setup — that the domain's A
record resolves to this server, or that it is a Cloudflare address — and prints the precise fix if something is off.
The check is advisory: it never blocks the install, and the panel stays reachable on its host port regardless.
If another service already listens on `:80`/`:443`, the installer keeps bring-your-own-proxy (Option B) and says so.

**Behind Cloudflare (orange cloud):** this works **without a token**. Cloudflare forwards `:80` to your server, so
HTTP-01 validates through the proxy. If the first certificate does not issue, set Cloudflare **SSL/TLS mode to
Full** (not *Flexible*) and turn **Always Use HTTPS** off while it does (or set the record to *DNS only* for a
minute), then set the domain again (Settings → Panel domain) or re-run the installer to make Tugra ask Let's Encrypt again. Prefer not to depend on `:80` reaching the server at all? A Cloudflare API token
switches the panel to **DNS-01** — a real certificate while the record stays proxied and your origin IP hidden — as
an *option*:

```bash
./scripts/install.sh --domain panel.example.com --acme-dns-cloudflare-file /path/to/token
```

(The token is stored only in the `0600` `.env` and handed to Traefik via a `0600` env-file. The installer itself
never puts it in a process argument, but a token typed after `--acme-dns-cloudflare` is visible in your shell
history and in `ps` for that command — prefer `--acme-dns-cloudflare-file <path>` (first line of the file) or
`TUGRA_ACME_DNS_TOKEN`; the installer warns when the token comes from the command line.)
Check or re-apply the panel's proxy anytime from **Settings → Panel HTTPS** (`GET`/`POST /instance/panel-tls`).

### Set the domain later (Settings → Instance → Panel domain)

A plain install already works on `http://<server-ip>/`. When you have a domain, point its DNS (A/AAAA record) at
the server and open **Settings → Instance → Panel domain** (owner only): enter it (the email is optional) and
**Set domain**. No token, no SSH, no installer re-run. Tugra, in this order:

1. adds the domain's routes to its proxy **next to** the current address (so the address you are using keeps
   working),
2. waits for the Let's Encrypt certificate (HTTP-01, same Cloudflare notes as above),
3. only then switches the instance's public URLs (`HUB_PUBLIC_URL`, `WEB_PUBLIC_URL`, `COOKIE_SECURE`,
   `HUB_TRUSTED_PROXY`, `PANEL_TLS`, `PANEL_DOMAIN` in `.env`; a raw hub/web port still published on every interface
   (`0.0.0.0`) moves to `127.0.0.1`, as `install.sh --domain` does) and recreates hub + web, then
4. checks that `https://<domain>/health` answers **from the server itself through the real DNS and proxy path**
   (a certificate on disk is not proof: Cloudflare *Flexible* or *Always Use HTTPS* can still loop) and reverts if it
   does not. On a host that cannot reach its own public address, set `PANEL_DOMAIN_PROBE=0` in `.env` to skip this
   check. The change runs on the
   update helper (the `tugra-updater` sidecar, the same checkout-and-docker path the in-app update uses; the hub
   never touches its own container). It needs a helper from this release — an older one is updated first
   (**Settings → Updates**) and the panel says so.

**Rollback:** if the certificate is not issued in time (DNS not pointing here, `:80` unreachable, Cloudflare SSL
mode *Flexible* …), the hub does not come up on the new address, or the new address does not answer when the server
tries it, the pending routes are dropped and the previous `.env` is restored and re-checked; the panel shows the
reason (if the previous setup cannot be confirmed healthy it says so instead of claiming the old address works). A
queued change the hub has given up on is removed from the update helper's queue and is never applied late. **Remove domain** goes
back to `http://<server-ip>/` the same way. After a switch you sign in again at the new address (cookies are per
origin), and agents installed on other servers with the old address need the new one (re-run their install command).

### Agents on a bare-IP install (no domain): encrypted, pinned

With no domain the proxy also answers `https://<server-ip>/` (port 443) with a **self-signed certificate the hub generates
once and keeps** (its key is encrypted at rest). The *add server* command then looks like

```sh
curl -fsSLk --pinnedpubkey 'sha256//<spki>' https://<ip>/install/agent.sh | sh -s -- \
  --hub wss://<ip>/agent --hub-pin sha256:<fingerprint> --token <token>
```

The installer is fetched over exactly that certificate and the agent talks to **nothing but that certificate**
(`--hub-pin`), so secrets in deploy environments are not readable on the network. Browsers will warn about the
self-signed certificate if you open `https://<ip>/` — use the `http://` address for the panel, or give it a domain. Port 443
must be reachable from your servers. Plain `ws://` is only used when you opt in (`--hub-insecure`; the UI shows a warning
next to such a command) or for a compose-internal address. A hub restored with a *different* `HUB_SIGNING_KEY` is refused by
agents that pinned the old one — set `TUGRA_HUB_REPIN=1` on those agents once, or keep the key (it is a required secret).

### Option B — bring your own reverse proxy

Run `--domain <host> --no-auto-tls` and front the stack with your own TLS proxy (Caddy, Traefik, nginx, …).

Either way, `--domain` sets `COOKIE_SECURE=true` and `HUB_TRUSTED_PROXY=true`. Route most traffic to the
**web** service (`:3001`); send only the paths the web can't handle to the **hub** (`:3000`):

| Path prefix | Route to |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth`, `/auth/oidc`, `/health`, `/version` | hub `:3000` |
| everything else (`/`, `/api/*`) | web `:3001` |

File uploads and downloads are streamed through the web service, so any body size limit in your proxy must allow the
largest file you want to move (the hub's default cap is 256 MiB per upload, `FILES_MAX_UPLOAD_BYTES`). Optionally route
`/api/v1/agent-fs/` straight to the hub `:3000`: it is only ever called by agents and carries whole file bodies. The same
goes for `/api/v1/agent-vx/`, the relay an app move streams a volume through in bounded parts (`MOVE_PART_MIB`, default
256 MiB; a value outside 32 to 1024 is clamped and the hub logs a warning): a proxy that caps request bodies below that part size answers the move's upload with 413,
so lower `MOVE_PART_MIB` or let those paths bypass the body limit.

Time limits on that path, from the browser to the agent. An upload is answered only after the hub has received the whole
body *and* the agent has pulled and applied it (budget: 30 s + 1 s per 512 KiB, at most 10 minutes):

| Hop | Limit | Setting |
|---|---|---|
| Your reverse proxy | its own read/send timeouts must allow the above (for example 15 minutes) | yours |
| Web service to hub | idle timeout 11 minutes (no headers or body timeout of its own, so a 10-minute apply is not cut) | `HUB_PROXY_TIMEOUT_MS` (web service environment) |
| Hub receiving the browser's body | Node's `requestTimeout`, raised to 15 minutes; `0` disables it | `HUB_REQUEST_TIMEOUT_MS` |
| Hub staging a body | cancelled when it trickles in: after a 20 s grace, at least 16 KiB per 10 s, and no longer than 60 s + size / 64 KiB/s (at most 10 minutes). A cancelled upload frees its slot, staged bytes and file | fixed |

The hub-side tunables for the file manager (set them in `.env`; the hub reads them at start):

| Variable | Default | Ceiling | Meaning |
|---|---|---|---|
| `FILES_MAX_UPLOAD_BYTES` | 256 MiB | 2 GiB | Largest single upload |
| `FILES_MAX_DOWNLOAD_BYTES` | 1 GiB | 64 GiB | Largest single download |
| `FILES_STAGING_MAX_BYTES` | 2 GiB | 64 GiB | Total bytes uploads may hold in staging at once (reserved from each upload's declared length; over it is `507 staging_full`) |
| `FILES_STAGING_DIR` | `<tmp>/tugra-files` (`/tmp/tugra-files` in the hub container's writable layer) | - | Where uploads are staged as private `<uuid>.part` files (mode 0600) until the agent has pulled them. Staged files are removed after each upload; leftovers older than 1 hour are swept at boot and hourly. The hub needs free space of at least twice the upload size here; mount a volume if the container disk is small |
| `FILES_MUTATIONS_PER_MIN` | 60 | - | File changes (upload, new folder, rename, permissions, delete) per user per minute; over it is `429 rate_limited` with `Retry-After` |
| `FILES_MAX_CONCURRENT_UPLOADS` | 2 | - | Uploads in flight per user per server, and per app; over it is `429 busy`. A server also accepts at most 4 file operations at once |
| `HUB_REQUEST_TIMEOUT_MS` | 900000 | - | See the table above |
| `HUB_PROXY_TIMEOUT_MS` | 660000 | - | See the table above (web service) |

## Sign in with GitHub

"Sign in with GitHub" works in both layouts. Create an OAuth app at <https://github.com/settings/developers>, set
`GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` in `.env`, restart the hub, and register the callback URL for
your layout:

| Layout | Authorization callback URL |
|---|---|
| Single-origin proxy (`--domain`) | `https://<host>/auth/oauth/github/callback` (your proxy already routes `/auth/oauth` to the hub, see the table above) |
| Raw two-port quick start (`http://<ip>:3001` + `http://<ip>:3000`) | `http://<ip>:3001/api/auth/oauth/github/callback` (the **web** port, not the hub port; it proxies the callback to the hub) |

The hub works the right URL out from `HUB_PUBLIC_URL` and `WEB_PUBLIC_URL`: one shared origin uses the first form,
different ports or hosts use the second. Set `GITHUB_OAUTH_CALLBACK_URL` only to force a different registered URL.
**Open the panel at exactly `WEB_PUBLIC_URL`** (same scheme, host and port) when you use GitHub sign-in: the login
cookie is set on the address you start from and GitHub sends you back to `WEB_PUBLIC_URL`, so starting from another
host name, `localhost`, or another port ends on the login page with a message asking you to use the configured
address. Each login is bound to the browser that started it (a short-lived `HttpOnly` cookie), and the session cookies keep
the `Secure` flag on HTTPS installs.

## Installer flags

| Flag | Effect |
|---|---|
| `--domain <host>` | Serve `https://<host>` (sets `COOKIE_SECURE` + `HUB_TRUSTED_PROXY`). Bring your own proxy unless `--auto-tls`. |
| `--auto-tls` | With `--domain`: auto-provision the panel's HTTPS (bundled Traefik + Let's Encrypt). Needs `--acme-email`. Opt-in. |
| `--no-auto-tls` | With `--domain`: keep bring-your-own-proxy (no bundled TLS). |
| `--acme-email <addr>` | Let's Encrypt contact email (required by `--auto-tls`; providing it implies `--auto-tls`). |
| `--acme-dns-cloudflare <token>` | DNS-01 via a Cloudflare API token — a real panel cert while the record stays proxied (IP hidden). Implies `--auto-tls`. The token is visible in `ps`/history; prefer the file form. |
| `--acme-dns-cloudflare-file <path>` | Same, reading the token from a file (first line) — keeps it out of argv and shell history. Env form: `TUGRA_ACME_DNS_TOKEN`. |
| `--cloudflare-proxy` | The panel's DNS record is Cloudflare-proxied (orange cloud): sets `HUB_TRUSTED_PROXY_CLOUDFLARE=true` so the hub uses `CF-Connecting-IP` as the client IP, only when the hop Traefik observed is a published Cloudflare edge range (needs an https `--domain`; opt-in, never implied by `--acme-dns-cloudflare`; see [Security](security.md)). |
| `--no-cloudflare-proxy` | Turn that off again. A flag-less re-run keeps whatever is configured. |
| `--keep-raw-ports` | Don't move the published hub/web ports from `0.0.0.0` to `127.0.0.1` when the install turns https / bundled TLS (also `TUGRA_KEEP_RAW_PORTS=1`). |
| `--hub-url <url>` | Explicit public hub URL (overrides `--domain`). |
| `--web-url <url>` | Explicit public web (browser) origin. |
| `--build` | Force building images from your checkout (skip pulling published images). |
| `--pull` | Force pulling published images (no source fallback). |
| `--env-file <path>` | Write the env file elsewhere (default `<repo>/.env`). |
| `--home` | Start the owner in the simple Home launcher instead of the full Fleet control plane. |
| `--no-telemetry` / `--enable-telemetry` | Opt out of / explicitly accept the anonymous usage stats (also `TUGRA_TELEMETRY=0\|1`). |
| `--no-update-checks` / `--enable-update-checks` | Opt out of (or re-enable) the signed self-update checks, which are on by default (also `TUGRA_UPDATE_CHECKS=0`). |
| `--public-ip <ip>` / `--detect-public-ip` | Pin this host's public IP (or opt in to a best-effort probe) so deployed-app URLs resolve from outside. |
| `--doctor` | Check this host and the Tugra stack without changing anything (ports 80/443, firewall, cloud provider, IPv6/DNS, containers, proxy routes, certificate, agent) and print the fix for each problem. Exit `0` = fine, `1` = problems. See [Troubleshooting](#troubleshooting). |
| `--restore-from <bundle>` | Restore a hub bundle made by `scripts/hub-migrate.sh pack` onto this host (see [Disaster recovery](disaster-recovery.md)). |
| `--yes`, `-y` | Assume yes for confirmation prompts. |
| `--dry-run` | Generate `.env` and exit — touch no Docker. |
| `-h`, `--help` | Print usage. |

### Published ports, binds and re-runs

The hub (`HUB_PORT`, default 3000) and web (`WEB_PORT`, default 3001) are published on `HUB_BIND`/`WEB_BIND`
(default `0.0.0.0` for the http quick start, where agents dial `host:3000`). With `HUB_TRUSTED_PROXY=true` the raw
ports only need to be reachable by your proxy, so a fresh `--domain` install binds them to `127.0.0.1`, and a
re-run that turns an http install into https (or brings the bundled TLS proxy live) moves a `0.0.0.0` bind to
`127.0.0.1` too (agents still dialing the old `http://host:3000` URL need the new https URL; opt out with
`--keep-raw-ports`). A bind you set yourself (e.g. a private-interface IP for a proxy on another host) is never
changed. Re-runs keep custom `HUB_PORT`/`WEB_PORT`, `--hub-url`/`--web-url` halves and the panel domain, and
upgrading with `git pull && ./scripts/install.sh` takes a pre-update backup first (see [Upgrade](upgrade.md)).

### Pinning what you run (curl | sh)

By default `bootstrap.sh` installs the newest published release: the highest `vX.Y.Z` tag (a stable release wins
over pre-releases; while there is no stable release yet, the newest beta) with its prebuilt images, so the one-line
command never builds unreleased code. `TUGRA_REF` overrides it — a branch (`TUGRA_REF=main` for the development
branch), a tag or a full commit SHA — and it fails loudly if it cannot fetch it. For a pinned install: `curl -fsSL …/bootstrap.sh | TUGRA_REF=<tag-or-sha> TUGRA_SHA256=<sha256 of
scripts/install.sh at that ref> sh`. Reading the script first (clone, `less scripts/install.sh`, run it) is still the
most conservative path.

## Configuration

Runtime configuration lives in the generated `.env`. See [`.env.example`](../.env.example) for every
key and what it does. The stability secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`SECRETS_ENCRYPTION_KEY`, `HUB_SIGNING_KEY`, `POSTGRES_PASSWORD`) are generated once and preserved
across re-runs — regenerating them would invalidate sessions, encrypted data and the signing identity.

**arm64 control plane:** the published hub/web/updater images are amd64-only. On an arm64 host
(e.g. a Pi control plane) run `./scripts/install.sh --build` to build natively; the agent image is
multi-arch, so managed servers of any architecture are supported.

## Troubleshooting

### Run the doctor first

```bash
./scripts/install.sh --doctor                                   # from the checkout
curl -fsSL https://tugra.io/install | sh -s -- --doctor   # on a fresh or installed host
```

The doctor is **read-only**: it never stops, starts, edits or installs anything, never writes `.env`, and the hosting
provider is recognised from local files (the only probes are requests to `127.0.0.1` and, for `--domain`, a DNS lookup).
The one-liner is read-only too: `bootstrap.sh --doctor` never installs git and never fetches or moves a checkout. It runs
the checkout this host already has (`./tugra`, `~/tugra`, or the directory the running stack was started from) exactly as
it is, local edits included. Only on a host with no checkout at all does it use a throwaway copy of the newest release,
deleted when it finishes. Run it as root (`sudo`) for the full picture: without root, process names behind a port are
hidden and a firewall that cannot be read is reported as unknown rather than as absent. It
works on a host where Tugra is not installed yet (then it shows what the installer will find) and on an installed one,
where it also reports the containers, the proxy routes, the certificate for `PANEL_DOMAIN` and the local agent. Every
red cross comes with its fix; the exit code is `0` when nothing is wrong and `1` otherwise, so it also fits a monitor.
The install runs the same port, firewall, provider and IPv6 checks as advice before it starts anything.

What it checks:

| Check | What you get |
|---|---|
| Who holds `80`/`443` (and `HUB_PORT`/`WEB_PORT`) | The process (from `ss -ltnp`) or, for `docker-proxy`, the container. Specific advice for nginx, Apache (`apache2`/`httpd`), Caddy, CloudPanel, Plesk, cPanel, Coolify's `coolify-proxy`, another Tugra, HAProxy/Traefik and anything else, with the exact command to free the port **and what it takes down**. Nothing is stopped for you. |
| Host firewall | `ufw`, `firewalld`, `nftables`, `iptables`: whether inbound `80`/`443` (a raw-port install: its hub/web ports) are allowed, and the one-line command if not. A missing rule is a red cross only when a host program (your own nginx in front of Tugra) serves that port: Tugra's own proxy and raw ports are published by Docker, which these rules do not filter, so for them it is a note. |
| Cloud provider | Hetzner, AWS, Google Cloud, Azure, DigitalOcean, Vultr, Linode/Akamai, Oracle, Scaleway, OVHcloud, Contabo or a generic KVM server, from `/sys/class/dmi/id`, cloud-init and the hostname; with where its cloud firewall lives (Hetzner Cloud Console → Firewalls, AWS Security Group inbound rules, …). |
| IPv6 / DNS | Whether the host has a global IPv6 (Tailscale / Docker unique-local `fc00::/7` addresses do not count) and whether the domain's AAAA record points at it (a stale one is a red cross on an installed hub); a private/NAT address; the A record and Cloudflare advice the installer already gives for `--domain`. |
| Tugra state | Containers up (including an agent that "Update agent" recreated outside compose as `tugra-agent-1`), `tugra-proxy`, the hub and the proxy routes on loopback, a valid certificate for `PANEL_DOMAIN`, and whether the local agent is connected (read from its log: a successful connect logs `hub session on <url> established`). |

### Port 80 or 443 is already used

The installer reports the holder and falls back to the raw ports (`http://<ip>:3001`) when `:80` is taken. To use
the proxy instead, either free the port or let the existing server front Tugra:

If your own nginx / Apache / CloudPanel already **fronts** Tugra ([Option B](#option-b--bring-your-own-reverse-proxy)), that
holder is expected: the doctor reports it as the proxy in front of Tugra and asks only that `80`/`443` stay reachable.

- **nginx / Apache / Caddy** — `sudo systemctl disable --now nginx` (or `apache2` / `httpd` / `caddy`) frees the port
  and takes every site that server hosts offline until you start it again. To keep it, route to Tugra from it (see
  [Option B](#option-b--bring-your-own-reverse-proxy)) and install with `--domain <host> --no-auto-tls`.
- **CloudPanel** — do not stop its nginx: that takes every CloudPanel site and the admin on `:8443` down. Keep it
  on 80/443 and add a vhost for the panel domain that follows the Option B routing table.
- **Plesk / cPanel** — they regenerate their web server config, so keep them and use the raw ports, a proxy rule
  in the panel, or a separate server for Tugra.
- **Coolify** — `docker stop coolify-proxy` frees the ports but takes every app Coolify serves offline. Two
  hubs that both want `:80`/`:443` belong on separate servers.
- **Another Tugra** — manage that one (`./scripts/install.sh --doctor` in its directory); two hubs cannot share one
  host's `:80`/`:443`.

### The panel is not reachable from outside

1. **Host firewall** — only matters for a program that runs on the host (your own nginx in front of Tugra); Tugra's
   own proxy and raw ports are published by Docker and skip `ufw`/`iptables` INPUT rules (see 3). `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp` (ufw),
   `sudo firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp && sudo firewall-cmd --reload` (firewalld).
   For iptables use `-I INPUT` (insert first) and for nftables `nft insert rule` (not `add`): a rule appended after a
   blanket `REJECT`/`drop` never matches, which is what Oracle Cloud images ship.
2. **Cloud firewall** — the provider's security group / firewall must allow TCP 80 and 443 (the doctor names where it
   is for your provider). A server without one attached is not filtered on Hetzner; AWS, Azure, Google Cloud and
   Oracle block everything not allowed.
3. **Docker bypasses ufw** — a published port is reachable even when `ufw` denies it, because Docker inserts its own
   NAT rules. Do not rely on `ufw` to hide the raw hub/web ports: use the cloud firewall, and keep them on loopback
   (`HUB_BIND=127.0.0.1`, `WEB_BIND=127.0.0.1` in `.env`; a domain install does this for you).
4. **Private address** — a cloud server behind NAT reports a private interface address; pass `--public-ip <ip>`.
5. **IPv6** — a stale AAAA record that points elsewhere (or at a host with no IPv6) breaks HTTPS and the certificate
   for IPv6 clients, because browsers and Let's Encrypt try IPv6 first. Delete the AAAA record or point it at this
   host, and allow TCP 80/443 for IPv6 in the cloud firewall.

### The certificate does not issue

The doctor reports "No valid certificate" when the proxy serves its self-signed default. Let's Encrypt must reach the
host over `:80`: the A record has to point at this server, `:80`/`:443` must be open (firewall and cloud firewall
above) and, behind Cloudflare, SSL/TLS mode must be `Full` with `Always Use HTTPS` off while the first certificate
issues. `docker logs tugra-proxy 2>&1 | grep -i acme` says why; re-run `./scripts/install.sh` afterwards.

## Next steps

- [First setup](first-setup.md) — the guided first ten minutes.
- [Add a server](add-a-server.md) and [Domains and Cloudflare](domains-and-cloudflare.md).
- [Upgrade](upgrade.md) — keep Tugra current (`git pull && ./scripts/install.sh`, or in-app updates).
- [CLI](cli.md) — drive Tugra from the terminal.
- [Architecture](architecture.md) — understand the moving parts.
