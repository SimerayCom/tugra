# Troubleshooting: domains, 404 / 502 and TLS

Tugra routes traffic with one **Traefik** proxy per server. The container is named `tugra-proxy` and sits on
a Docker network also named `tugra-proxy`. Each app declares its routing as Traefik labels (generated in
`traefikLabels`, `apps/hub-api/src/deploy/deploy-script.ts`). The proxy publishes host ports 80 and 443 (see
`proxyBind` below).

## 404 vs 502: read the status first

These are Traefik behaviors, so the meaning is the same as in any Traefik setup:

- **404 `page not found`**: Traefik is reachable but **no router matches** this hostname. The request never
  reached your app.
- **502 `Bad Gateway`**: a router **matched** but Traefik could not get a valid answer from the container.

### 404 checklist

1. **Is the app deployed and running?** Labels are applied when the container is created. Changing a domain
   or expose mode only takes effect on the **next deploy** (`PUT /apps/:id/domain`, `expose`).
2. **Does the hostname match the app's domain exactly?** The rule is `Host(<domain>)`. If a canonical
   redirect is set, the router answers for both `domain` and `www.domain`; without it, only the exact host.
3. **Right IP?** Resolve the hostname and compare it to the server: `GET /apps/<id>/domain/manual-records?domain=<d>`
   returns the records Tugra expects. Hitting the server IP directly always returns 404 (no Host match).
4. **Is the proxy running?** `GET /servers/<serverId>/proxy`, then `POST /servers/<serverId>/proxy/restart`
   if it is stopped or absent. A deploy of a domained app also (re)creates it.
5. **Compose app?** Only the **web service** gets labels. If no web service is selected, there is no router.
   Set the compose web service on the app, then redeploy.

### 502 checklist

1. **Wrong container port.** The router sends traffic to `containerPort` (default **80** when unset). If your
   app listens on 3000, set `containerPort` to 3000 and redeploy. This is the most common cause.
2. **App listens on `127.0.0.1` only.** It must bind `0.0.0.0` to be reachable from the proxy network.
3. **App crashed or is still starting.** Read the logs (below). Domained apps get an automatic HTTP health
   gate on deploy (`healthCheckType` auto-derives to HTTP); a failing app is rolled back when
   `rollbackOnFailure` is on, so a persistent 502 after a deploy often means the previous version is the one
   serving, or the health path is wrong. Tune it with `PUT /apps/<id>/healthcheck` (`type`, `path`, `port`).
4. **Not on the proxy network.** Single-container apps are attached automatically. For a compose app, Tugra
   joins the web service to `tugra-proxy` **and** keeps it on the project `default` network through its
   override file. If you wrote a `networks:` block for that service yourself, check it still reaches its own
   database.

## Where to look: logs

| What | Where |
|---|---|
| App/container logs | `GET /apps/<id>/logs?tail=200`; live follow `GET /apps/<id>/logs/stream` (SSE; `container=` picks a compose service); export `GET /apps/<id>/logs/download`. All need the `read:secrets` scope. |
| Build/deploy logs (live) | `GET /apps/<id>/deployments/stream` (SSE) |
| Proxy (Traefik) logs, including ACME errors | `GET /servers/<serverId>/proxy/logs` |

Certificate problems show up in the **proxy** logs, not in the app logs.

## Domain modes

| Mode | Domain | Scheme | Cert |
|---|---|---|---|
| **Magic** (default for new apps) | `<name>-<hash>.<ip-with-dashes>.sslip.io`, or `<name>-<hash>.<wildcardDomain>` if the server has a wildcard root | **Plain HTTP** | none |
| **Magic with a DNS-01 wildcard** | `<name>-<hash>.<wildcardDomain>` | HTTPS | wildcard via `le-dns` |
| **Custom** (`PUT /apps/:id/domain`) | your domain | HTTPS, with `:80` to `:443` redirect | Let's Encrypt HTTP-01 (`le-http`) |

(`magic-domain.ts`, `applications.service.ts` `resolveExpose`/`setDomain`.)

Important consequences:

- A magic `*.sslip.io` URL is **HTTP only** by design. "Not secure" on it is expected; use a custom domain or
  a DNS-01 wildcard for HTTPS.
- Magic domains need a **public** server IP. If the server only has a private/CGNAT address, Tugra will not
  build one (it returns none); pin the real public IP in the server's network settings.
- A tunnel-only server (`proxyBind: "none"`) with no wildcard gets no auto magic domain.

## HTTP-01 vs DNS-01

Tugra always configures a resolver `le` (HTTP-01). It adds a second resolver `le-dns` (DNS-01) **only when the
server has a DNS provider and credentials** (`buildProxySetupScript`).

| | HTTP-01 (`le-http`, resolver `le`) | DNS-01 (`le-dns`) |
|---|---|---|
| Used by | every custom domain by default | server `certMode: "le-dns"` |
| Needs | domain resolves to this server; **port 80 reachable from the internet** | DNS provider API credentials on the server |
| Wildcard `*.example.com` | no | yes |
| Works behind a firewall / tunnel on :80 | no | yes |
| One cert covers | one hostname | the wildcard plus the apex as a SAN |

### HTTP-01 fails: common causes

1. DNS does not point at this server yet (or still has the old Coolify/other IP: lower the TTL first).
2. Port 80 is blocked by a cloud firewall, `ufw`, or the host provider. The challenge is served on `:80`.
3. A Cloudflare **proxied** (orange cloud) record in front of it. Tugra's auto-setup creates DNS-only
   records for exactly this reason (a proxied record plus Flexible SSL causes a redirect loop).
4. `proxyBind` is `loopback` or `none` (another web server or a tunnel owns 80/443): HTTP-01 cannot be
   reached from outside. Use DNS-01 or the tunnel.
5. Let's Encrypt rate limits after many failed attempts. Read the proxy logs for the exact ACME error and wait.

### Turn on a DNS-01 wildcard

Set it on the server (`PUT /servers/<id>/network`, `servers.schemas.ts`):

```bash
tugra api PUT /servers/<serverId>/network --data '{
  "certMode": "le-dns",
  "dnsProvider": "cloudflare",
  "dnsCreds": { "CF_DNS_API_TOKEN": "<token with Zone:DNS:Edit>" },
  "wildcardDomain": "apps.example.com"
}'
```

Notes:

- `dnsProvider` is the Traefik/lego provider code and `dnsCreds` are that provider's environment variables.
  Credentials are encrypted at rest, written to the proxy as a `0600` env-file, and never returned by the API.
- Changing these settings updates the server's magic domains. **The proxy only picks up new DNS credentials or
  a new `proxyBind` when it is recreated**: use `POST /servers/<id>/proxy/start` or deploy a domained app. A
  plain `proxy/restart` keeps the old container's configuration.
- If the stored credentials cannot be decrypted, Tugra sets the proxy up **without** the `le-dns` resolver
  instead of failing (fail-safe), so wildcard certs silently stop working. If wildcard HTTPS disappears after a
  secret/key change, re-enter the credentials.
- Swarm ingress with two or more replicas **requires** DNS-01, because an HTTP-01 challenge cannot be routed
  to one specific replica behind the swarm mesh (`swarm-proxy.service.ts`).

## Cloudflare one-click DNS

For custom domains on Cloudflare, Tugra can create the records for you. v1 supports **Cloudflare only**
(`dns/dto.ts`).

1. Store a Cloudflare credential for the team (`POST /dns-credentials`, provider `cloudflare`, an API token that
   can edit DNS on the zone). The token is verified against Cloudflare, encrypted, and never shown again.
   `POST /dns-credentials/:id/test` re-checks it.
2. Preview, which writes nothing:

   ```bash
   tugra apps domain <appId> <your-domain> --dry-run
   ```

3. Apply, which creates the apex A/AAAA records plus an optional `www` CNAME, all **DNS-only**, sets the app's
   domain and HTTPS (`le-http`), and wires the `www`/apex redirect:

   ```bash
   tugra apps domain <appId> <your-domain>
   # API: POST /apps/<id>/domain/auto-setup {"domain":"...","includeWww":true,"dryRun":false}
   ```

4. Redeploy so the labels pick up the domain, then check: `POST /apps/<id>/domain/verify` does a real public
   DNS lookup and reports `expected` vs `resolved` addresses and `lastError`.

Behavior worth knowing:

- **It is conservative.** A pre-existing record that points somewhere else is a *conflict* and apply returns
  **409** listing them. Re-run with `--overwrite` (`"overwrite": true`) only if you intend to repoint them.
  Records that already match are left alone (`noop`).
- **Credential not found / zone not found**: with more than one credential on the team, pass
  `--credential <id>` (`credentialId`). The token must have access to the zone that contains the domain.
- **Scope**: auto-setup and cleanup need the `deploy` scope; a token with only `read` or `write` gets 403.
- **Clusters**: one A record per ingress node is created, for failover.
- **Cleanup**: `DELETE /apps/<id>/domain/dns` removes only records Tugra *created*; records that already
  existed or were repointed are left untouched. Deleting the app does this best-effort.
- **Not on Cloudflare?** `GET /apps/<id>/domain/manual-records?domain=<d>` returns the exact records to create
  by hand.

## Common fixes at a glance

| Symptom | Likely cause | Fix |
|---|---|---|
| 404 on a fresh domain | App not redeployed since the domain was set, or DNS points at the wrong IP | Redeploy; check `manual-records` and `verify` |
| 502 right after deploy | Wrong `containerPort`, app bound to localhost, or crash | Set `containerPort`, bind `0.0.0.0`, read the logs |
| Browser says "Not secure" on `*.sslip.io` | Magic domains are HTTP by design | Add a custom domain or a DNS-01 wildcard |
| Certificate never issues | Port 80 blocked / DNS not pointing / proxied record | See HTTP-01 causes above; read proxy logs |
| Redirect loop behind Cloudflare | Proxied record with Flexible SSL | Make the record DNS-only (auto-setup does this) |
| Wildcard works then stops | DNS credentials unreadable or token revoked | Re-enter `dnsCreds`, then `proxy/start` |
| `proxyBind` change ignored | Only applied when the proxy is recreated | `POST proxy/start` or deploy a domained app |
| `409` from auto-setup | Existing DNS record points elsewhere | Review the listed records; use `--overwrite` if intended |
| Port 80/443 already used on the box | Another web server owns them | Set `proxyBind` to `loopback` (behind your own proxy) or `none` (tunnel-only) |
