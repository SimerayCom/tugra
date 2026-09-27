# API

Tugra exposes a versioned REST API that powers the web UI and the [`tugra` CLI](cli.md), and that you
can drive directly from scripts or your own tools.

## Overview

- Base path: **`/api/v1`** (a stable contract; the OpenAPI `info.version` is `1.0.0`, independent of the
  build version).
- ~160 endpoints covering servers, applications, databases, backups, deployments, monitors,
  notifications, teams, projects and instance settings.
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

## Instance gating

The instance owner can restrict API (PAT) access without affecting the web app:

- **`apiEnabled`** — a kill-switch. When off, all PATs are rejected; browser sessions keep working.
- **`apiAllowedIps`** — an allowlist of IPs/CIDRs. When set, PAT requests from other addresses are refused
  (honoring `HUB_TRUSTED_PROXY` for the observed source IP).

Both are managed under **Settings → API access**.

## Routing notes

The `/api/v1` prefix applies to all REST routes except a few bare, unversioned endpoints —
`/health`, `/version`, `/install/agent.sh`, the `/webhooks/*` receivers and `/auth/oauth/github(/callback)`
— which external systems call at fixed paths. The `/agent` and `/terminal` WebSocket upgrades are separate
and unprefixed.

## MCP server

Tugra also runs an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server at
**`POST /api/v1/mcp`**, so AI assistants and agents can query an instance directly. It's JSON-RPC 2.0 over
plain HTTP (Streamable-HTTP transport, protocol version `2025-06-18`) — no SSE or stdio; `GET /api/v1/mcp`
returns `405` with `Allow: POST`.

- **Status:** read-only (Phase 1). Mutating and migration tools are planned for a later phase.
- **Auth:** the same PAT/session + scope model as the REST API above — a PAT works out of the box, and the
  `apiEnabled` kill-switch and IP allowlist apply here too. The caller's identity always comes from the
  resolved token, never anything the client asserts, so a client can't widen its own team scope.
- **Methods:** `initialize`, `ping`, `notifications/initialized`, `notifications/cancelled`, `tools/list`,
  `tools/call`. Requests may be batched (a JSON array); notifications (no `id`) return no body (`202`).
- **Tools:** 17 read tools across applications, servers, clusters/swarm, databases and monitors — e.g.
  `list_applications`, `get_application`, `list_deployments`, `get_app_logs`, `list_containers`,
  `get_app_env_keys`, `list_servers`, `get_server`, `get_server_capabilities`, `list_clusters`,
  `get_cluster`, `get_cluster_status`, `list_databases`, `get_database`, `list_backups`, `list_monitors`,
  `get_monitor`. `tools/list` returns only the tools the token's scopes satisfy; `tools/call` re-checks the
  scope server-side regardless. Most tools need only `read`; `get_app_logs` needs `read:secrets`
  (container logs can contain secrets).
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
