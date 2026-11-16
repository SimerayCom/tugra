# SSL/DNS cutover runbook (imported apps)

Moves the hostnames of an imported Coolify app to Tugra with a valid certificate and a controlled DNS switch.
Where it lives: the cutover step of the import wizard, the API under `/import/operations/<opId>/cutover/*`, and
the CLI `tugra import cutover <opId> <action>`. The same steps also run inside a
[guided migration run](guided-migration.md) (DNS_PREPARE, TLS_PREISSUE, CUTOVER, OBSERVE, FINALIZE), which adds the
data copy, a verification gate, a typed point-of-no-return approval and an abort path around them; this page remains
the reference for what each cutover action does.

## What it promises (and what it does not)

- **Cloudflare zone + DNS-01:** the certificate is issued on the Tugra server *before* DNS moves, so TLS is valid on
  the first request after the switch. Stale resolvers keep reaching Coolify (which serves the same code) for at most
  the old TTL, or for about 60 s if you lowered it in time.
- **Proxied (orange-cloud) records:** TTL does not apply; the origin switches at the Cloudflare edge within seconds. A
  pre-issued origin certificate is what keeps *Full (strict)* valid. Tugra keeps the record proxied and checks the
  zone's SSL mode (Flexible/Off blocks the flip; Full only warns).
- **Zones Tugra cannot write to (manual DNS):** Tugra never touches your DNS. It prints the records and the TTL
  guidance (measured at the zone's authoritative nameservers) and advances the host when public resolvers show the
  Tugra IP. Without a pre-issued certificate there is a bounded gap while HTTP-01 issues after the switch: the flip
  needs an explicit `acceptHttp01Gap`.
- **Stateful apps:** downtime is the data-move window (the migrator), not this tool. A host whose database or volume
  data task is not DONE is *stateful* and the flip needs `acceptDataRisk`.
- **Split brain:** the Coolify API token is read-only, so Tugra **cannot stop the source app**. After a stateful
  flip, stale-DNS clients keep writing to Coolify until you stop it. The panel and `flip-plan` print the steps.
- **Rollback:** *Revert* restores DNS exactly. It cannot restore data written on Tugra after the flip (nothing syncs
  backwards). Auto-revert is **off** and never applies to a stateful host.
- **Not zero downtime.** Nothing here claims it.

## What it never does

- Flips a record it did not plan: a request only matches hostnames that already exist as entries of the op; the flip
  is bound to a `planHash` that includes every record's old content, so a provider-side change since you reviewed the
  plan aborts the flip. TXT/MX/CAA/NS records are never touched.
- Writes anything to a provider on `init`, `check`, `cert-prepare`, `plan`.
- Includes Coolify-generated hostnames (`app-<24 chars>.<zone>`; excluded by default, include them explicitly) or
  tunnel-routed hosts (a CNAME to `*.cfargotunnel.com`: `BLOCKED(tunnel-routed)`, switch the tunnel ingress yourself).
- Carries certificates over unless you opted into `--certs` (see below).

## Order of operations

1. **Enable DNS-01 on the target server, before any live app lands there.** Server page, *Use a team DNS credential*
   (or `tugra servers dns-credential <serverId> <credentialId>`). The token is *copied* (encrypted) into the proxy's
   env file; a rotated credential does not propagate until you re-apply it. Applying recreates the proxy (seconds of
   ingress drop), so do it before traffic, never just for the cutover on a busy server. The token needs Zone:Read and
   DNS:Edit on every zone you migrate; a token scoped per zone set is preferred. Set a **real ACME contact email**
   (Settings) - Let's Encrypt rejects placeholders and the flip refuses while it is one.
2. **Deploy dark.** The imported app is deployed on Tugra while DNS still points at Coolify.
3. **`init`** - derives the hostnames (primary, aliases, compose service domains, an evidenced www/bare sibling),
   resolves each Cloudflare zone through your team DNS credential (`--credential` to pick one) and reads the current
   records read-only. Review: excluded/blocked hosts, `proxied`, `viaWildcard`, CAA warnings.
4. **`prepare-certs --challenge dns01`** (or `http01`) - turns on per-host DNS-01 for the app; a host the server's
   credential cannot see, or a CAA policy that forbids Let's Encrypt, is blocked. It does not deploy: **redeploy** the
   app (entries show `needsDeploy`).
5. **`check`** - handshakes with the Tugra server's IP using each hostname as SNI and fetches the health path with
   the `Host` header (no redirects followed). A host becomes READY only when the certificate is valid for it and the
   app answers. `TRAEFIK DEFAULT CERT` means the router is not loaded or the certificate is not issued yet.
6. **`ttl`**, then **wait at least the old TTL**. Cloudflare records are lowered (minimum 60 s); the earliest flip
   time is shown. For manual zones the panel gives the time to lower it by.
7. **`plan`** - the exact record diff per host and the `planHash`. Read the warnings: stale AAAA deleted, CNAME
   replaced, explicit record created for a wildcard-only host, proxied kept, TTL not waited, HTTP-01 gap.
8. **`flip --confirm <planHash>`** - paced batches (5 hosts, 30 s apart by default; target TTL 60 s). A failed
   verification halts the run (`--no-stop-on-fail` to continue). Per host: ledger saved before the first write,
   write, read-back, three public resolvers plus the authoritative nameserver, then certificate and health through the
   target. `cancel` stops after the current batch.
9. **Stop the Coolify app** (printed steps). Do it before the target takes writes if it is stateful.
10. **Observe** real traffic for a while.
11. **`finalize`** - puts the original TTL back.
12. **Decommission** Coolify only after Tugra served traffic and backed up successfully.

## www / bare hosts

The importer does not set a www/bare redirect. If the source also served the sibling host (evidence: it resolves the
same as the primary), `init` lists it as `BLOCKED(counterpart-not-served)`. `fix-counterpart --direction root|www`
sets the redirect on the app (redirect www to the bare domain with `root`) and needs a redeploy; with a redirect Traefik
requests one certificate with both names, and with DNS-01 that does not depend on the A record.

## Reverting

`revert --hosts a,b --acknowledge-data-loss` restores each record from the ledger: it deletes what Tugra created,
patches back what it updated, recreates what it deleted (a stale AAAA, a replaced CNAME). If a record changed since the
flip the host becomes `CONFLICT` and **nothing is overwritten**; `--force` restores anyway. After Tugra has taken
writes, dump Tugra back to Coolify first - there is no reverse sync.

## Seeding source certificates (optional)

Only for hosts that cannot use DNS-01 (non-Cloudflare zones). Run the migrator with `--certs`: it reads the Coolify
proxy's `acme.json`, keeps only certificates for hostnames **the hub** lists for this op (the source never decides),
drops the ACME account key, and uploads them over the migration token. The hub validates them (not expired, key matches
the certificate), encrypts the private key at rest and stages it. Nothing is served until `seed-certs`: it stops the
target proxy, merges the certificates into the proxy's **own** `acme.json` (so Traefik keeps renewing them; a missing
account is not invented), rewrites it atomically and **always** recreates the proxy. The proxy restart drops ingress
for every app on that server for a few seconds, so do it before live apps land there (`--acknowledge-proxy-restart`).
Staged keys are blanked once applied. Experimental until verified on a real Traefik; `check` is the only judge of
whether a certificate is actually served.

## Inside a guided run

When a [guided run](guided-migration.md) drives the cutover, these rules are unchanged and the run adds to them:

- **The same plan-hash flip.** The run calls `flip` with the plan hash it showed you; a provider-side change since you
  reviewed it aborts the flip exactly as it does by hand. It also passes the data-risk acknowledgement from your typed
  approval, so a stateful host never flips without it.
- **The point of no return is set before the first stateful write.** From then on the run refuses `abort`; the way back
  is `reverse`, which uses the same ledger restore as `revert --acknowledge-data-loss` and is equally lossy for data
  Tugra wrote after the flip.
- **Auto-revert stays off** for stateful hosts.
- **The Coolify freeze is still yours unless you configured otherwise.** The Coolify API token is read-only, so by
  default the run prints the stop steps and records your attestation as `operator-attested` evidence. Only a write
  token (`sourceController: api`) or an agent on the source host (`sourceController: agent`) lets the run stop the
  source itself; neither has been exercised on a real host yet.
- **Same-host takeover (proxy swap) is different.** There is no DNS write, so there is nothing to lower or flip: the
  run stops the Coolify proxy, starts Tugra's, and verifies from the hub with SNI for every host. The loopback probe
  of `check` is **not** valid there while Coolify still owns :80/:443 (it would verify Coolify's router, not Tugra's),
  so the run uses a separate dark probe against the Tugra proxy container. HTTP-01 certificates cannot be issued while
  Coolify owns port 80: DNS-01 or seeded certificates are required before the swap. None of this has been verified
  on a real host; see the verification status in the guided runbook.

### A fleet inside a guided run

When a run places resources on several Tugra servers or carries hosts that cannot all move at once, the cutover decides
**per host** (the full rules, inputs and attestation ids are in the
[guided runbook](guided-migration.md#the-cutover-for-a-fleet)):

- A host that depends on the source's **object storage** stays on the source under the default policy (`hold`), or flips
  later once its object data is verified (`mirror`). The dependency is judged from environment variable **names**, so the
  gate lists which hosts were held and why; treat a missed host as possible.
- **Manual-DNS hosts** get an exact per-host record checklist and a per-host confirmation or deferral. A deferred host
  is reported as **not cut over**; it never fails the run and it never flips.
- **HTTP-01 gap** acceptance is per host, and a host can be **left out** of the run.
- Hosts flip **one target server at a time**, with the point of no return recorded once, and after the cutover each git
  app behind a moved host gets a webhook-repoint warning (guidance only; the run changes no webhook).
- The same-host **proxy swap** refuses the Coolify control plane's own box and refuses a run that spans several target
  servers. None of the swap behaviour has been verified on a real host.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| `certState=default-cert` | Router not loaded (deploy the app) or certificate not issued yet; see `certError` (a Cloudflare 403 means the token does not cover the zone). |
| `BLOCKED zone-not-covered` | The server's DNS credential cannot see this hostname's zone. |
| `BLOCKED caa-blocks-letsencrypt` | A CAA record forbids Let's Encrypt; add `0 issue "letsencrypt.org"`. |
| flip refused `acme-email` | The server's ACME email is missing or a placeholder. |
| flip refused `ssl-mode-bad` | A proxied host in a zone whose SSL mode is Flexible/Off (redirect loop); set Full (strict). |
| `CONFLICT record-changed` | A DNS record changed between the plan and the write; nothing was written for it. Re-plan. |
| run `halted` after a hub restart | The run stopped mid-way; entries mid-switch are settled from the provider on the next view. Review and flip again. |
