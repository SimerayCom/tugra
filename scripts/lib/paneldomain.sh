#!/usr/bin/env bash
# Panel-domain job for the update sidecar (sourced by update.sh; needs its log, run, compose, redis, env_get,
# env_put, set_env, json_str, wait_healthy and job_field helpers).
#
# The hub (Settings -> Instance -> Panel domain) has ALREADY configured the proxy and verified the Let's Encrypt
# certificate by the time a job lands here, so this step only does what `install.sh --domain` does to the instance's
# own configuration: switch the public URLs in .env and recreate hub-api + web. It is the one place with the checkout
# and docker.sock; the hub never touches either. Job (flat strings, like an update job):
#   {"action":"panel-domain","jobId":"<uuid>","domain":"<host>"|"","acmeEmail":"<addr>"|"","publicIp":"<ipv4>"|"","requestedAt":"<epoch s>"}
# domain set    => https://<host> (COOKIE_SECURE, trusted proxy, bundled TLS, the host-less IP route off)
# domain empty  => back to http://<publicIp>/ behind the same proxy (the IP route on)
# Any failure puts the previous .env back and recreates the previous configuration: the old URL keeps working.
# Progress is reported to the hub under instance:panel-domain:updater (applying | applied | failed).

PANEL_DOMAIN_STATUS_KEY="instance:panel-domain:updater"
PANEL_DOMAIN_MAX_AGE="${PANEL_DOMAIN_MAX_AGE:-600}"

pd_status() { # <jobId> <phase> [<error text>]
  local err="null"
  [ -z "${3:-}" ] || err="\"$(json_str "$3")\""
  redis SET "$PANEL_DOMAIN_STATUS_KEY" "{\"jobId\":\"$1\",\"phase\":\"$2\",\"error\":$err}" EX 3600
}

# A bare hostname (no scheme, port, path, wildcard or IP literal) — the same shape the hub validates.
pd_valid_domain() { [ "${#1}" -le 253 ] && [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; }
pd_valid_ipv4() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
# A contact email without anything that could break a .env line or a shell word.
pd_valid_email() { [ "${#1}" -le 320 ] && [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }

# Put the saved .env back the same way every .env write happens: a same-dir temp, then an atomic rename.
pd_restore_env() { # <saved copy>
  local tmp
  if [ "$DRY" -eq 1 ]; then printf 'RUN: restore %s from the saved copy\n' "$ENV_FILE"; return 0; fi
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || return 1
  cp -p "$1" "$tmp" && _fsync_file "$tmp" && mv "$tmp" "$ENV_FILE" || { rm -f "$tmp"; return 1; }
}

panel_domain_job() {
  local job="$1" id domain email ip req now saved
  id="$(job_field "$job" jobId)"
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || { log "panel-domain: ignoring a job without a valid id"; return 0; }
  domain="$(job_field "$job" domain)"; email="$(job_field "$job" acmeEmail)"; ip="$(job_field "$job" publicIp)"
  req="$(job_field "$job" requestedAt)"; now="$(date +%s)"
  # A job older than a few minutes is stale (the hub gave up on it and rolled back): never apply it late.
  if [[ "$req" =~ ^[0-9]+$ ]] && [ $((now - req)) -gt "$PANEL_DOMAIN_MAX_AGE" ]; then
    pd_status "$id" failed "the change was queued too long ago and was not applied"; return 0
  fi
  if [ -n "$domain" ]; then
    pd_valid_domain "$domain" || { pd_status "$id" failed "invalid panel domain"; return 0; }
    if [ -n "$email" ] && ! pd_valid_email "$email"; then pd_status "$id" failed "invalid ACME email"; return 0; fi
  else
    pd_valid_ipv4 "$ip" || { pd_status "$id" failed "a public IPv4 is required to leave the domain"; return 0; }
  fi

  pd_status "$id" applying
  if [ "$DRY" -eq 1 ]; then
    saved="$ENV_FILE.saved"; printf 'RUN: save a copy of %s\n' "$ENV_FILE"
  else
    saved="$(mktemp "${ENV_FILE}.panel-domain.XXXXXX")" && cp -p "$ENV_FILE" "$saved" || { rm -f "${saved:-}"; pd_status "$id" failed "could not save a copy of .env (disk full?)"; return 0; }
  fi

  if [ -n "$domain" ]; then
    set_env HUB_PUBLIC_URL "https://$domain" && set_env WEB_PUBLIC_URL "https://$domain" \
      && set_env COOKIE_SECURE true && set_env HUB_TRUSTED_PROXY true \
      && set_env PANEL_TLS 1 && set_env PANEL_DOMAIN "$domain" && set_env PANEL_IP_ROUTE 0 \
      && { [ -z "$email" ] || set_env ACME_EMAIL "$email"; }
  else
    set_env HUB_PUBLIC_URL "http://$ip" && set_env WEB_PUBLIC_URL "http://$ip" \
      && set_env COOKIE_SECURE false && set_env HUB_TRUSTED_PROXY true \
      && set_env HUB_TRUSTED_PROXY_CLOUDFLARE false \
      && set_env PANEL_TLS 0 && set_env PANEL_DOMAIN "" && set_env PANEL_IP_ROUTE 1
  fi || {
    pd_restore_env "$saved" || log "panel-domain: could not put .env back — the saved copy is $saved"
    [ "$DRY" -eq 1 ] || rm -f "$saved"
    pd_status "$id" failed "could not write .env"; return 0
  }

  if compose up -d --no-deps hub-api web && wait_healthy hub-api web; then
    [ "$DRY" -eq 1 ] || rm -f "$saved"
    pd_status "$id" applied
    if [ -n "$domain" ]; then log "panel domain: now https://$domain"; else log "panel domain: now http://$ip"; fi
    return 0
  fi

  log "panel domain: hub-api/web did not come up on the new URL — restoring the previous configuration"
  if pd_restore_env "$saved" && compose up -d --no-deps hub-api web && wait_healthy hub-api web; then
    [ "$DRY" -eq 1 ] || rm -f "$saved"
    pd_status "$id" failed "the hub did not become healthy on the new URL; the previous URL was restored"
  else
    pd_status "$id" failed "the hub did not become healthy on the new URL and the previous configuration could not be verified — .env copy: $saved"
  fi
  return 0
}
