# Testing the Tugra beta

Thank you for trying Tugra while it is in beta. This page is the short version of "what to try, what to
expect, and how to tell us when something breaks". Ten minutes is enough for the first pass.

## 1. Install (≈ 5 minutes)

On a fresh Ubuntu/Debian host with Docker (the installer installs Docker if it is missing):

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | bash
```

Then open `http://<server-ip>:3001`, create the owner account and finish onboarding. For a real domain with
HTTPS, re-run the installer with `./scripts/install.sh --domain tugra.example.com --auto-tls --acme-email you@example.com`
(see [install.md](install.md)). The installer is safe to re-run; it takes a database + `.env` restore point before
changing anything on an existing install.

The server you installed on is already enrolled as an agent ("This machine"). Add more servers from
**Infrastructure → Servers** — each runs a single agent container that dials out to the hub (no inbound port).

## 2. What to try

Pick what matches how you would actually use it. Each item takes a couple of minutes.

- **Deploy from Git** — a Node/Python/Go repo (Nixpacks), or one with a Dockerfile. Watch the build log live,
  then open the deployment row: timeline, commit, image, config diff, full log.
- **Deploy from the App Store** — pick a template (Uptime Kuma, Gitea, Immich…), one click, open the URL.
- **Give it a domain** — set a domain on the app; Traefik issues the certificate. Try an extra domain and a
  redirect.
- **Break a deploy on purpose** — push a commit that fails its health check with *Deploy strategy: rolling* and
  *Roll back on failure* on. The previous version should stay live and the deployment should say so.
- **Databases** — create PostgreSQL, take a backup to local or S3 storage, run **Verify latest backup**, restore
  it into a throwaway. Enable **Point-in-time recovery** on the Postgres database, wait for a base backup, then
  restore to a moment in the past into a new database.
- **Fleet** — enroll a second server, put both in a cluster, run one bulk command across them, then start a
  **Rollout** across several apps (canary → waves) and halt/resume it.
- **Operations** — restart the hub (`docker compose restart hub-api` in the install directory) while a deploy
  is running: the deploy should finish and be picked back up, not be marked failed.
- **Self-update** — Settings → Instance → Updates. Check, apply, and confirm the restore point appeared under
  `backups/` in the install directory.
- **MCP** — mint a personal access token and point an MCP client at `POST /api/v1/mcp` (see the README's MCP
  quick start). Try `list_applications` and a deploy.

## 3. Known limitations in the beta

- Published hub/web images are **amd64**; an arm64 host builds from source (several minutes, ~2 GB RAM).
- Point-in-time recovery is **PostgreSQL only**; other engines have scheduled logical dumps + restore-verify.
- Volume backups are **file-level copies**, not consistent snapshots — stop the app first for a database volume.
- Swarm (clustered) deploys that are *queued* when the hub restarts are cancelled, not resumed (single-server
  ones resume).
- "Sign in with GitHub" works only behind the single-origin HTTPS proxy setup (`--domain`), not on the raw
  two-port install.
- The in-app updater updates the hub and web (and now the local agent); a release that changes the compose file
  or the scripts still needs `git pull && ./scripts/install.sh`.
- Pro/Cloud (SSO/OIDC, audit export, white-label) are not available yet; the core is complete and free.

## 4. Reporting a bug

Open an issue with the **Bug report** template: https://github.com/SimerayCom/tugra/issues/new/choose

Please include:

- **Version** — Settings → Instance → Updates, or `curl -s http://<hub>:3000/api/v1/version`.
- **What you did, what you expected, what happened** — one or two lines each is fine.
- **Logs** — from the install directory:

  ```bash
  cd ~/tugra   # or wherever bootstrap.sh put it
  docker compose --env-file .env -f deploy/docker-compose.yml logs --since 30m hub-api web agent > tugra-logs.txt
  ```

  For a failed deployment, the full build log is on the deployment's page (**Copy** button). Build logs can
  contain secrets echoed by your own build — skim before pasting.
- **Environment** — OS, `docker --version`, whether the hub sits behind a reverse proxy or Cloudflare.

The panel also has a **Send feedback** button on the Settings page, which prefills a GitHub issue with your version and environment, or
downloads a report you can attach.

Security issues: do **not** open a public issue — see [SECURITY.md](../SECURITY.md).

## 5. If an update goes wrong

The updater restores the previous version automatically when a new one fails to start. If the panel shows
**recovery required**, follow the steps in [upgrade.md](upgrade.md#rollback--troubleshooting); the pre-update
restore point (`backups/pre-update-*.dump` + `.env` copy) is your fallback — see
[disaster-recovery.md](disaster-recovery.md). Please report what happened either way; a failed update is the
kind of bug we most want to hear about.

## 6. Stars, discussions, ideas

- Feature ideas and questions: [GitHub Discussions](https://github.com/SimerayCom/tugra/discussions).
- If Tugra is useful to you, a star on the repository genuinely helps others find it.
