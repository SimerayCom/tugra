# API

Tugra exposes a versioned REST API that powers the web UI and the [`tugra` CLI](cli.md), and that you
can drive directly from scripts or your own tools.

## Overview

- Base path: **`/api/v1`** (a stable contract; the OpenAPI `info.version` is `1.0.0`, independent of the
  build version).
- ~250 endpoints covering servers, applications (incl. one-click domain DNS setup), databases, backups,
  deployments, monitors, notification channels, registries, Git sources, cloud & DNS credentials, teams,
  the audit log, saved views, projects and instance settings.
- The committed contract lives at [`apps/hub-api/openapi.json`](../apps/hub-api/openapi.json).

## Interactive docs & spec

- **Swagger UI:** `GET /api/docs` — browse and try endpoints against a running hub.
- **OpenAPI JSON:** `GET /api/v1/openapi.json` — the machine-readable spec (feed it to a client generator).

## Authentication

Two schemes:

- **Personal access token (PAT)** — send `Authorization: Bearer tugra_pat_…`. Mint a token in the web UI
  under **Settings → API tokens**; the CLI and external tools use PATs. Tokens cannot be minted through the
  API itself (no self-mint) — they're created in the UI and copied once.
- **Session cookie** (`tg_access`) — used by the web app after you sign in. Browser sessions are not
  scope-limited.

## Scopes

Every PAT carries a set of scopes; a request needs the scope its route requires.

| Scope | Grants |
|---|---|
| `read` | Read-only access (implied by any other scope). |
| `write` | Create and modify resources. |
| `deploy` | Deploy, restart, run backups, apply updates. |
| `read:secrets` | Read decrypted secret values (env vars, connection strings). |
| `admin` | Everything, including delete. |

Routes without an explicit requirement use a method default: `GET` → `read`, `POST/PUT/PATCH` → `write`,
`DELETE` → `admin`. `admin` (and the wildcard a browser session holds) satisfies any requirement.

Teams, notification channels, registries, Git sources, cloud credentials, DNS credentials, the audit log and
saved views accept PATs as well as browser sessions (reads need `read`, mutations `write`, deletes `admin`;
secret-bearing reads such as team invite tokens need `read:secrets`, and privileged team mutations — invites,
role and member-access changes — need `admin`). Personal-access-token *management* itself stays session-only
(a PAT cannot mint, list or revoke tokens).

## Instance gating

The instance owner can restrict API (PAT) access without affecting the web app:

- **`apiEnabled`** — a kill-switch. When off, all PATs are rejected; browser sessions keep working.
- **`apiAllowedIps`** — an allowlist of IPs/CIDRs. When set, PAT requests from other addresses are refused
  (honoring `HUB_TRUSTED_PROXY` for the observed source IP).

Both are managed under **Settings → API access**.

## Rate limits

Every personal-access-token request is counted against a per-token budget (a fixed window in Redis, separate
from the coarse global per-IP throttle). Each response carries:

- `X-RateLimit-Limit` — the budget per window.
- `X-RateLimit-Remaining` — requests left in the current window.
- `X-RateLimit-Reset` — Unix time (seconds) when the window resets.

Over budget returns `429 Too Many Requests` with a `Retry-After` (seconds) header. Browser sessions are not
per-token limited. The budget and window default to 300 requests / 60s and are set with the `API_RATE_LIMIT`
and `API_RATE_WINDOW_SEC` environment variables; a Redis outage fails open (requests are allowed, not blocked).

This per-token budget is a second dimension on top of a global **per-IP** throttle (120 requests/min). For a
client calling from a single IP the per-IP throttle is the binding limit; the per-token budget exists to bound a
leaked token spread across many IPs. If you drive the API hard from one host, set `API_RATE_LIMIT` with the
per-IP throttle in mind.

## Idempotency

Send an `Idempotency-Key: <unique-value>` header on a `POST` (e.g. creating an app or triggering a deploy) and
a safe retry won't run twice. The first request with a given key executes and its result is stored for 24h;
a retry with the same key replays that exact status + body instead of re-running, and a second request that
arrives while the first is still in flight gets `409`. Keys are scoped to your account + the method + the path.
It's opt-in (no header → normal behaviour) and fails open (a Redis outage just runs the request).

## Routing notes

The `/api/v1` prefix applies to all REST routes except a few bare, unversioned endpoints —
`/health`, `/version`, `/install/agent.sh`, the `/webhooks/*` receivers and `/auth/oauth/github(/callback)`
— which external systems call at fixed paths. The `/agent` and `/terminal` WebSocket upgrades are separate
and unprefixed.

## DNS auto-setup (custom domains)

Point a custom domain at an app in one call, using a team Cloudflare credential (Cloudflare only in this
release). Store the credential first, then drive the app-domain routes. The Cloudflare API token is verified
before it is saved, stored encrypted, and never returned by any response.

| Method & path | Scope | What it does |
|---|---|---|
| `GET /dns-credentials` | `read` | List the team's DNS credentials (never the token). |
| `POST /dns-credentials` | `write` | Store a Cloudflare credential (`teamId`, `name`, `provider:"cloudflare"`, `apiToken`, optional `cfAccountId`); needs the `integrations` team permission. |
| `PUT /dns-credentials/:id` | `write` | Rename / replace the token. |
| `POST /dns-credentials/:id/test` | `write` | Re-verify the stored token against Cloudflare. |
| `DELETE /dns-credentials/:id` | `admin` | Remove a credential. |
| `POST /apps/:id/domain/auto-setup` | `deploy` | Create the apex `A`/`AAAA` (+ optional `www` `CNAME`) records and wire the app's HTTPS. Body: `domain`, optional `credentialId` (defaults to the team's single Cloudflare credential), `includeWww` (default true), `overwrite` (default false), `dryRun`. `dryRun:true` returns the plan without writing. Records are created **DNS-only** (never proxied). A record that already points elsewhere, or a type-incompatible record (a `CNAME` where an `A` is wanted), is reported as a conflict and only replaced when `overwrite:true`; `TXT`/`MX` records are never touched. |
| `GET /apps/:id/domain/manual-records?domain=&includeWww=` | `read` | The copy-paste records to create by hand at any other DNS provider (no Cloudflare call). |
| `POST /apps/:id/domain/verify?hostname=` | `read` | A live public-DNS lookup reporting whether the domain resolves to the app (`active` / `pending` / `error`). Side-effect-free. |
| `DELETE /apps/:id/domain/dns?hostname=` | `deploy` | Remove the records Tugra created for the domain (only records it created; never a pre-existing one). |

The same flow is available from the CLI (`tugra apps domain`) and from the `setup_app_domain` / `verify_app_domain` MCP tools.

## MCP server

Tugra also runs an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server at
**`POST /api/v1/mcp`**, so AI assistants and agents can query an instance directly. It's JSON-RPC 2.0 over
plain HTTP (Streamable-HTTP transport, protocol version `2025-06-18`) — no SSE or stdio; `GET /api/v1/mcp`
returns `405` with `Allow: POST`.

- **Status:** read **and** write. 36 tools total — 18 read + 18 PAT-scoped mutate/ops tools. OAuth for
  third-party clients (dynamic client registration, `/authorize`, `/token`, PKCE) is still planned; today a
  PAT is the only credential.
- **Auth:** the same PAT/session + scope model as the REST API above — a PAT works out of the box, and the
  `apiEnabled` kill-switch and IP allowlist apply here too. The caller's identity always comes from the
  resolved token, never anything the client asserts, so a client can't widen its own team scope.
- **Methods:** `initialize`, `ping`, `notifications/initialized`, `notifications/cancelled`, `tools/list`,
  `tools/call`. Requests may be batched (a JSON array, capped at 20 messages; each message is charged against
  the burst limit); notifications (no `id`) return no body (`202`).
- **Read tools (17):** across applications, servers, clusters/swarm, databases and monitors — e.g.
  `list_applications`, `get_application`, `list_deployments`, `get_app_logs`, `list_containers`,
  `get_app_env_keys`, `list_servers`, `get_server`, `get_server_capabilities`, `list_clusters`,
  `get_cluster`, `get_cluster_status`, `list_databases`, `get_database`, `list_backups`, `list_monitors`,
  `get_monitor`, plus `verify_app_domain` (live public-DNS check for an app's custom domain). Most need only
  `read`; `get_app_logs` needs `read:secrets` (logs can contain secrets).
- **Mutate/ops tools (18):** each is a thin wrapper over the same service method + team-permission check +
  domain audit the REST API uses, so no new authorization path is introduced. **`deploy` scope:** app
  lifecycle (`deploy_application`, `restart_application`, `stop_application`, `start_application`,
  `rollback_application`, `scale_application` — live scaling), swarm ops (`form_swarm`, `join_swarm_node`,
  `add_swarm_manager`, `set_ingress_replicas`), one-click custom-domain DNS (`setup_app_domain`, with a
  `dryRun` preview), and the fleet wedge `fleet_app_action` (fan a reversible lifecycle action across a whole
  cluster's apps, preview-then-confirm, 25-app cap). **`write` scope:**
  `set_env_var`, `delete_env_var` (safe single-key merge — values are never returned). **`admin` scope:**
  the irreversible `dissolve_swarm`, `remove_application` (each requires echoing the resource's exact name to
  confirm), and `remove_swarm_manager`, `leave_swarm_node`. `tools/list` returns only the tools the token's
  scopes satisfy; `tools/call` re-checks the scope server-side regardless — a `read`-only token sees and can
  call none of the mutate tools.
- **Agent-safety note:** a `deploy`- or `admin`-scoped PAT handed to an AI client can change and tear down
  real infrastructure. Scope tokens to the minimum an agent needs (a read-only PAT for pure observability),
  and treat a token as equivalent to the REST actions it unlocks. The name-confirmation on the two
  irreversible tools is a guard against accidental fan-out, not a substitute for scoping the token.
- **Redaction:** every tool result is sanitized before it reaches the (third-party) AI client — named
  secret/credential fields are nulled, Markdown code fences in strings are neutralized (a prompt-injection
  defense), strings are truncated, and nesting is depth-capped. No tool ever returns a decrypted secret
  value; environment variables come back as key names only.
- **Limits & audit:** 30 calls per 10s per user (`429` / JSON-RPC `-32000` past that); every `tools/call` is
  written to the audit log (actor, tool, arguments, outcome).

## Related

- [CLI](cli.md) — the official client for this API.
- [Security](security.md) — auth, scopes and gating in the wider security model.
- [Open-core & editions](open-core.md) — the API is a Community feature.
