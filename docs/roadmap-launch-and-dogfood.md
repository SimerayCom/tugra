# Launch, dogfood & Cloud roadmap

> Status: strategy spec (2026-10-24). Decisions recorded here so they are not lost in chat.
> Owner context: Simeray Ltd is a **software studio** (not a hosting reseller). It builds 17+ web/mobile/backend
> products (own + client) and today manages ~20 servers (client-owned + its own infra) from **one Coolify hub**,
> code → push → auto-deploy. Tugra is Simeray's own open-core PaaS product. Two goals: launch tugra.io publicly,
> and dogfood by moving Simeray's own fleet onto a Tugra hub.

## The model (one line)

A Tugra **hub** is a **single-operator control plane** (first user = owner, registration then closes —
`schema.prisma` InstanceSettings singleton + `auth.service.ts` register). It is **not** a multi-tenant SaaS.
It manages a fleet of servers through an outbound-only agent; client apps run on the fleet; end users hit the
apps, never the hub. No per-seat / per-server limit exists and the licence public key is empty, so every install
is Community = the full product.

## Decision: migrate first, do NOT wait for Cloud

Migrate Simeray's own fleet off Coolify **now**, in waves, and launch the OSS product + site **in parallel**
under a Beta label. Tugra Cloud (hosted, multi-tenant) is an unbuilt, multi-month project that would run on the
same core we must harden anyway. Our own ~20 servers are the cheapest real-world test of the migrator, Swarm and
DNS-01, and **"we run our own fleet on it"** is the strongest launch claim.

## Phase 0 — Launch OSS + site (~1 week, no new servers)

The product code is already public (`SimerayCom/tugra`, AGPL). The site is 100% static Astro → **Cloudflare Pages
(free)**, NOT a Tugra hub (a beta-hub outage must not take down the page that explains how to install Tugra).

Site launch checklist (repo `mrcandev/Tugra-Platform`, `apps/site`):
1. **PUSH NOW** — `main` is 4 commits ahead of origin; GitHub HEAD is still the empty scaffold, so the whole site
   exists only on the local Mac. `git push origin main`. (No edits needed; repo is private.)
2. Add `404.astro` and drop the `try_files … /index.html` nginx fallback (today `/pricing`, `/docs` soft-404 to the
   homepage).
3. Publish the minimum pages from the design handoff (`/docs`, `/security`, `/legal`, `/pricing`, `/features`,
   `/compare`, `/compare/coolify`) **or** trim the nav to existing pages — 15+ header/footer links are dead today.
4. Replace the dead `/cloud` "Sign in" with a "coming soon / waitlist" (the only place Resend is plausibly needed
   in v1).
5. SEO/social: sitemap, robots.txt, og:image, `_headers` (security headers + long-cache `/_astro/*`), README
   product screenshot. Make `ci.yml` actually run `build:site`.
6. Lazy-load the ~658 KB three.js hero only in view + honour `prefers-reduced-motion`.
7. Deploy to Cloudflare Pages; in Cloudflare DNS replace the 4 Squarespace apex A records with the Pages target,
   add `www` redirect, **keep the MX** (`receive.forge.rmta.net`).
8. Verify `security@/license@/conduct@tugra.io` actually deliver (SPF/DKIM/DMARC) before `/security` promises them.

Product launch blockers (tracked in `[[launch-durum-canli]]` / the owner's blockers file): cut **v0.1.8** from a
green SHA (v0.1.7 is 35 commits behind main — migrator/linking/UX unreleased), GitHub Private Vulnerability
Reporting on, mail channel working, copyright-holder consistency.

Do NOT build `apps/cloud` / `apps/crm` / `apps/worker` / Stripe for launch.

## Phase 1 — Dogfood own fleet (~6–10 weeks, part-time)

- **Wave 0:** one new **dedicated hub server** (NOT a Coolify box — 80/443 clash), installed via
  `./scripts/install.sh --domain <hub-host>` behind your own TLS proxy, `HUB_PUBLIC_URL` set to a public HTTPS URL
  (e.g. `hub.tugra.io` or `panel.simeray.com`). Day-0: back up Postgres + `.env` (JWT, `SECRETS_ENCRYPTION_KEY`,
  `HUB_SIGNING_KEY`) and drill a restore. Reinstall from a **tagged release image**, not the hot-patched test box.
  Run `smoke-vm.sh` on a throwaway VM.
- **Wave 1 (canary):** 1–2 of your own stateless or Postgres/MySQL projects, 3–7 day soak, keep Beszel as the
  neutral watchdog.
- **Wave 2:** your own production (2–3 projects), a real backup **restore** per engine, 1-week soak.
- **Wave 3:** client servers one at a time, **with written consent**, onto a fresh server so DNS flip-back is the
  rollback. Never use a client as the canary.
- Importer caveat: `apply` is **whole-instance** (single `targetServerId`, no per-server filter) → use the Coolify
  importer for **read-only** plan/inventory only; recreate apps per project via API/CLI; move DBs by manual
  dump + `import-from-url`. Keep the Coolify app **stopped** after cutover; keep Coolify running a few clean days.
- Take an **independent** DB backup (outside both Coolify and Tugra) before every cutover.

## Phase 2 — Tugra Cloud (later, only if outsiders ask for hosted)

Decision: **one isolated hub ("cell") per customer**, never a shared multi-tenant hub for v1. The code favours
this: the hub is a single-operator trust root (one `SECRETS_ENCRYPTION_KEY`, one `HUB_SIGNING_KEY` signing every
agent command incl. terminal/host-exec with the Docker socket). In-hub isolation is **app-level only** — no
Postgres RLS, no `teamId` on `AuditLog`. A compromised shared hub = root on every tenant's servers; a cell caps
the blast radius at one customer.

Start hand-provisioned (a managed single cell per customer, or "self-host + install support") before any
automation. Then build the proprietary `@tugra/cloud-*` layer: a control-plane/provisioner (cell = hub-api + web +
Postgres + Redis, wildcard DNS + TLS, templated from `deploy/docker-compose.yml`, reusing `apps/hub-api/src/cloud`
for VM creation), per-cell unique keys, billing + metering + a signed-licence issuer (set the real licence pubkey),
per-cell backup/DR, upgrade orchestration, an operator console, and a load test. A shared multi-tenant hub (tenant
model, RLS, per-tenant keys, team-scoped audit, cross-instance command bus, pen-test) is a still-larger build.

## Scaling & limits (single hub) — all estimates until load-tested

- hub-api is a **single Node process**: agent sockets live in an in-memory Map → **no replicas**, vertical scale
  only. Fix before any tenant has hundreds of servers: a command bus / shared socket registry.
- Metrics ingest inserts **one row per sample, unbatched** (~200 host inserts/s at 1000 servers by estimate). Fix:
  batch + partition.
- A cell with 1–50 servers is well within one hub's range; a heavy customer gets a bigger VM for that cell only.
- **"1000 servers" is handled by adding cells, not by making one hub bigger.**

## Isolation rule (keep three separate hubs)

1. **Studio + clients** hub — one Team per client, clients as restricted VIEWER / custom role (never ADMIN).
2. **Cloud** deployment — one cell per paying customer.
3. **Rehearsal** hub — for upgrade/migration drills.

Your clients and Tugra's future customers must never share a hub.

## CloudPanel sites (bonus, after Wave 2 — not a launch blocker)

CloudPanel is **not** an importer source (only `coolify` + `local-docker` adapters exist). Each site is a manual
re-platform: static → STATIC build app; Node/Next/SPA → GIT app (Nixpacks/Dockerfile); PHP/Laravel/WordPress →
small Dockerfile or the official image + a named volume for uploads (check the 279-template store first). Move DBs
with `mysqldump --single-transaction` → `POST /databases` → `/provision` → `backups/import-from-url`. Build one PHP
template and clone it; leave low-value stable sites where they are.

## Immediate next action

`cd /Users/simeray/Desktop/Tugra-Platform && git push origin main` — protect the 4 unpushed commits that hold the
entire tugra.io site. Then the first site task is `404.astro` + removing the nginx soft-404 fallback.
