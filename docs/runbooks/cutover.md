# SSL/DNS cutover runbook (imported apps)

Moves the hostnames of an imported Coolify app to Tugra with a valid certificate and a controlled DNS switch.
Where it lives: the cutover step of the import wizard, the API under `/import/operations/<opId>/cutover/*`, and
the CLI `tugra import cutover <opId> <action>`.

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
