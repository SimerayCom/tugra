#!/usr/bin/env bash
# Network health checks for the hub installer: who holds :80/:443 (and the raw hub/web ports), the host firewall, the
# hosting provider's cloud firewall, IPv6 / AAAA, and -- for `install.sh --doctor` -- the state of the Tugra stack itself.
# Sourced by install.sh (needs its log/ok/warn/bad/note helpers, env_get, ENV_FILE, COMPOSE_FILE, and for the doctor
# _local_ip / is_private_ipv4 / warn_private_ip / panel_dns_preflight).
#
# READ-ONLY by contract: nothing here stops, starts, edits or installs anything, and nothing calls out to the network
# (the provider is recognised from local files only; the one outbound-looking probe is a request to 127.0.0.1). When
# something is in the way the operator gets the exact command and what it would take down, and decides.
#
# Test seams (never needed in production): TUGRA_FS_ROOT prefixes every path read below (/proc, /run, /var/lib/cloud,
# /home/clp, /usr/local/...), TUGRA_DMI_ROOT overrides /sys/class/dmi/id, TUGRA_HOSTNAME overrides `hostname`.

NC_FS="${TUGRA_FS_ROOT:-}"
NC_DMI="${TUGRA_DMI_ROOT:-$NC_FS/sys/class/dmi/id}"
NC_PROBLEMS=0   # hard findings (a red cross); `--doctor` exits 1 when there is one
NC_STRICT=0     # 1: a foreign port holder / blocked port is a problem (the install is served through Tugra's proxy), else advice

nc_problem() { bad "$@"; NC_PROBLEMS=$((NC_PROBLEMS + 1)); }
# An advisory when it only matters for a future setup, a problem when this install depends on it.
# A definite breakage on an INSTALLED hub (NC_WARN_COUNTS=1: a red cross and an exit code), else just a warning.
nc_warn_counted() { if [ "${NC_WARN_COUNTS:-0}" = "1" ]; then nc_problem "$@"; else warn "$@"; fi; }
nc_finding() { if [ "$NC_STRICT" = "1" ]; then nc_problem "$@"; else note "$@"; fi; }
nc_t() { if command -v timeout >/dev/null 2>&1; then timeout "${NC_TIMEOUT:-6}" "$@"; else "$@"; fi; }
nc_lc() { printf '%s' "$*" | tr 'A-Z' 'a-z'; }
nc_first_line() { # <file> -> its first line, trimmed; "" when unreadable
  [ -r "$1" ] || return 0
  head -n1 "$1" 2>/dev/null | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}
nc_sudo() { if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then printf ''; else printf 'sudo '; fi; }

# ---------------------------------------------------------------------------------------------------------------------
# 1. Who holds a port
# ---------------------------------------------------------------------------------------------------------------------

# "name|pid" per distinct listener of TCP port $1 (any address, v4 or v6). "?|" when the process is not visible (not root).
nc_holders() {
  command -v ss >/dev/null 2>&1 || return 0
  nc_t ss -ltnp 2>/dev/null | awk -v p="$1" '
    $4 ~ ("[:.]" p "$") {
      name = "?"; pid = ""
      if (match($0, /users:\(\("[^"]*"/)) { s = substr($0, RSTART, RLENGTH); sub(/^users:\(\("/, "", s); sub(/"$/, "", s); name = s }
      if (match($0, /pid=[0-9]+/)) pid = substr($0, RSTART + 4, RLENGTH - 4)
      if (!(name in seen)) { seen[name] = 1; print name "|" pid }
    }' || true
}

# The container(s) publishing host port $1 (docker-proxy only shows up as "docker-proxy"), one name per line.
nc_containers_for_port() {
  command -v docker >/dev/null 2>&1 || return 0
  nc_t docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | awk -F'|' -v p="$1" '$2 ~ (":" p "->") && !s[$1]++ {print $1}' || true
}

nc_is_cloudpanel() { [ -d "$NC_FS/home/clp" ] || [ -d "$NC_FS/etc/cloudpanel" ] || command -v clpctl >/dev/null 2>&1; }
nc_is_plesk()      { [ -d "$NC_FS/usr/local/psa" ] || command -v plesk >/dev/null 2>&1; }
nc_is_cpanel()     { [ -d "$NC_FS/usr/local/cpanel" ]; }

# Classify a holder by process name ($1) and container name ($2): sets NC_KIND.
nc_kind() {
  local n c; n="$(nc_lc "$1")"; c="$(nc_lc "$2")"
  NC_KIND=generic
  case "$c" in
    tugra-proxy) NC_KIND=tugra-proxy; return 0 ;;
    tugra-*)     NC_KIND=tugra; return 0 ;;
    coolify*)    NC_KIND=coolify; return 0 ;;
    "") ;;
    *) NC_KIND=container; return 0 ;;
  esac
  case "$n" in
    clp*|*clpctl*) NC_KIND=cloudpanel ;;
    nginx*)  if nc_is_cloudpanel; then NC_KIND=cloudpanel; elif nc_is_plesk; then NC_KIND=plesk; elif nc_is_cpanel; then NC_KIND=cpanel; else NC_KIND=nginx; fi ;;
    apache2*|httpd*) if nc_is_plesk; then NC_KIND=plesk; elif nc_is_cpanel; then NC_KIND=cpanel; else NC_KIND=apache; fi ;;
    cpsrvd*|cpanel*) NC_KIND=cpanel ;;
    sw-engine*|psa*|plesk*) NC_KIND=plesk ;;
    caddy*)   NC_KIND=caddy ;;
    haproxy*) NC_KIND=haproxy ;;
    traefik*) NC_KIND=traefik ;;
    docker-proxy*) NC_KIND=docker ;;
  esac
}

# "nginx (pid 812)" / "container coolify-proxy" / "a process": a readable name for a port holder. Args: <process> <pid> <container>.
nc_who() {
  local who="${1:-something}"
  [ "$who" = "?" ] && who="a process"
  [ -n "${2:-}" ] && who="$who (pid $2)"
  [ -n "${3:-}" ] && who="container $3"
  printf '%s' "$who"
}

# Print what to do about a foreign holder of $1 (role "proxy": Tugra's own proxy needs it; "raw": the hub/web publish it).
# Args: <port> <role> <kind> <process> <pid> <container>. Never changes anything: it names the command and its consequence.
nc_advise_holder() {
  local port="$1" role="$2" kind="$3" proc="$4" pid="$5" cont="$6" who unit s
  s="$(nc_sudo)"
  who="$(nc_who "$proc" "$pid" "$cont")"
  unit="$(printf '%s' "$proc" | sed 's/[^A-Za-z0-9_.@-].*$//')"
  # :80 and :443 are normally the same web server: say what to do once, not twice.
  if [ "${NC_LAST_ADVICE:-}" = "$role|$kind|$proc|$cont" ]; then nc_finding "Port $port is held by $who, the same as above."; return 0; fi
  NC_LAST_ADVICE="$role|$kind|$proc|$cont"
  nc_finding "Port $port is held by $who."
  if [ "$role" = "raw" ]; then
    note "Tugra publishes its hub/web on :$port, so it could not bind it. Pick other ports: HUB_PORT=3100 WEB_PORT=3101 ./scripts/install.sh (stored in .env), or stop what holds it."
    [ -n "$cont" ] && note "To stop it:  ${s}docker stop $cont  (whatever that container serves goes offline)"
    [ -z "$cont" ] && [ -n "$unit" ] && [ "$unit" != "?" ] && note "Find out what it is:  ${s}ss -ltnp 'sport = :$port'  ·  stopping it takes whatever it serves offline."
    return 0
  fi
  case "$kind" in
    nginx)
      note "That is a system web server, not Tugra. Tugra did not touch it: it falls back to the raw ports (:3000/:3001), or you put Tugra behind nginx with --domain (routing table: docs/install.md#option-b--bring-your-own-reverse-proxy)."
      note "To give Tugra the port instead:  ${s}systemctl disable --now nginx  -- every site nginx serves goes offline until you start it again (${s}systemctl enable --now nginx)." ;;
    apache)
      note "That is a system web server, not Tugra. Tugra did not touch it: it falls back to the raw ports (:3000/:3001), or you put Tugra behind Apache with --domain (docs/install.md#option-b--bring-your-own-reverse-proxy)."
      note "To give Tugra the port instead:  ${s}systemctl disable --now ${unit:-apache2}  -- every site it serves goes offline until you start it again." ;;
    caddy)
      note "Caddy can front Tugra itself (reverse_proxy to 127.0.0.1:3001, /agent* and the other hub paths to :3000 -- docs/install.md#option-b--bring-your-own-reverse-proxy), or Tugra can use the raw ports (:3000/:3001) meanwhile."
      note "To give Tugra the port instead:  ${s}systemctl disable --now caddy  -- every site Caddy serves goes offline until you start it again." ;;
    cloudpanel)
      note "That is CloudPanel's web server. Do NOT stop it for Tugra: ${s}systemctl stop nginx would take every site CloudPanel hosts offline (and the CloudPanel admin on :8443)."
      note "Keep CloudPanel on 80/443 and let it front Tugra: add a site for the panel domain with a custom vhost that sends / to 127.0.0.1:3001 and /agent, /terminal, /install, /webhooks, /auth/ to 127.0.0.1:3000, then run the installer with --domain <host> --no-auto-tls (docs/install.md#option-b--bring-your-own-reverse-proxy). Until then Tugra stays on the raw ports (:3000/:3001)." ;;
    plesk)
      note "That is Plesk's web server (Plesk regenerates its config, so hand edits are overwritten and stopping it takes every Plesk-hosted site offline)."
      note "Keep it: front Tugra from Plesk (Apache & nginx Settings of the panel domain -> additional nginx directives, routing table in docs/install.md#option-b--bring-your-own-reverse-proxy), or run Tugra on the raw ports (:3000/:3001) or on its own server." ;;
    cpanel)
      note "That is cPanel/WHM's web server (Apache, or ea-nginx in front of it): cPanel rewrites its config, and stopping it takes every cPanel-hosted site offline."
      note "Keep it and run Tugra on the raw ports (:3000/:3001) or on its own server; cPanel has no supported way to put a custom reverse proxy in front of a whole domain, so a hand-made vhost may be overwritten on the next rebuild." ;;
    coolify)
      note "That is Coolify's proxy (Traefik). Coolify and Tugra cannot both own :80/:443 on one host, and Tugra did not touch it: it falls back to the raw ports (:3000/:3001)."
      note "To give Tugra the port instead:  ${s}docker stop ${cont:-coolify-proxy}  -- every app Coolify serves through its proxy goes offline, and Coolify may start the proxy again by itself. Usually better: Tugra on its own server." ;;
    tugra-proxy)
      note "That is another Tugra install on this host (its proxy tugra-proxy). Two hubs cannot share one host's :80/:443: manage the existing one (run its ./scripts/install.sh --doctor from its directory)."
      note "To free the port:  ${s}docker stop tugra-proxy  -- that hub's panel and every app it routes through the proxy goes offline." ;;
    tugra)
      note "That is another Tugra container (${cont:-tugra}) holding a port this install needs. Stop that stack from its own directory (docker compose down) or choose other HUB_PORT/WEB_PORT." ;;
    haproxy|traefik)
      note "That is another reverse proxy. Tugra did not touch it: it falls back to the raw ports (:3000/:3001), or you route to Tugra from it with --domain (docs/install.md#option-b--bring-your-own-reverse-proxy)."
      note "To give Tugra the port instead:  ${s}systemctl disable --now ${unit:-$kind}  -- whatever it serves goes offline." ;;
    container)
      note "Tugra did not touch it: it falls back to the raw ports (:3000/:3001) or you route to Tugra from that proxy (docs/install.md#option-b--bring-your-own-reverse-proxy)."
      note "To give Tugra the port instead:  ${s}docker stop $cont  -- whatever that container serves goes offline." ;;
    *)
      note "Tugra did not touch it: it falls back to the raw ports (:3000/:3001), or you free the port."
      if [ "$proc" = "?" ] || [ -z "$proc" ]; then
        note "Run as root to see which process it is:  ${s}ss -ltnp 'sport = :$port'  (stopping it takes whatever it serves offline)."
      else
        note "To free it, stop that service (for a systemd unit:  ${s}systemctl disable --now ${unit:-<unit>}  -- whatever it serves goes offline)."
      fi ;;
  esac
}

# Report host port $1. Returns 0 when it is free or held by this Tugra install, 1 when something else holds it.
nc_port_check() { # <port> <proxy|raw>
  local port="$1" role="$2" holders conts first proc pid cont ours=0
  holders="$(nc_holders "$port")"
  if [ -z "$holders" ]; then
    # `ss` only lists sockets of this namespace/permissions; a published container port still shows up in docker ps.
    conts="$(nc_containers_for_port "$port")"
    if [ -z "$conts" ]; then ok "Port $port is free"; return 0; fi
  fi
  first="$(printf '%s\n' "$holders" | head -n1)"
  proc="${first%%|*}"; pid="${first#*|}"
  conts="$(nc_containers_for_port "$port" | head -n1)"
  cont="$conts"
  nc_kind "$proc" "$cont"
  case "$NC_KIND" in
    tugra-proxy) [ -s "${ENV_FILE:-/nonexistent}" ] && ours=1 ;;
    tugra) [ "$role" = "raw" ] && ours=1 ;;
  esac
  if [ "$ours" = "1" ]; then ok "Port $port is held by Tugra's own ${cont:-proxy} (this install)"; return 0; fi
  # Bring-your-own-proxy install (PANEL_TLS=0 behind the operator's nginx / Apache / CloudPanel ...): the holder IS the front door.
  if [ "$role" = "proxy" ] && [ "${NC_BYO:-0}" = "1" ] && [ "$NC_KIND" != "tugra-proxy" ] && [ "$NC_KIND" != "tugra" ]; then
    ok "Port $port is held by $(nc_who "$proc" "$pid" "$cont"), the proxy in front of Tugra (bring-your-own-proxy install)"
    return 0
  fi
  nc_advise_holder "$port" "$role" "$NC_KIND" "$proc" "$pid" "$cont"
  return 1
}

# ---------------------------------------------------------------------------------------------------------------------
# 2. Host firewall
# ---------------------------------------------------------------------------------------------------------------------

# Cloud firewall / Docker note shared by every firewall flavour.
nc_docker_bypass_note() {
  note "Docker-published ports bypass ufw/iptables INPUT rules (Docker inserts its own NAT rules), so a ufw 'deny' does NOT hide a published port: block unwanted ports in your cloud firewall and keep the raw hub/web ports on loopback (HUB_BIND=127.0.0.1 WEB_BIND=127.0.0.1)."
}

# The name of a HOST process (not docker-proxy, not a container, not an unreadable "?") that listens on port $1, "" otherwise.
# Only such a listener goes through the INPUT chain: a Docker-published port is DNAT'd and takes the FORWARD path.
nc_native_holder() {
  local line name
  [ -z "$(nc_containers_for_port "$1")" ] || return 0
  while IFS= read -r line; do
    name="${line%%|*}"
    case "$name" in ""|"?"|docker-proxy*) continue ;; esac
    printf '%s' "$name"; return 0
  done <<<"$(nc_holders "$1")"
}

# Report ports $3.. as not allowed by firewall $1. $2 is the function that prints the fix command for a port list
# (the caller may set NC_FIX_NOTE first: a line printed after the command). A block is a finding only for a port a host process listens on (an own nginx for the
# bring-your-own-proxy setup); Tugra's own proxy and raw ports are Docker-published and INPUT rules do not filter them.
nc_fw_blocked() { # <firewall> <fixfn> <ports...>
  local fw="$1" fixfn="$2" real="" desc="" other="" p n; shift 2
  for p in "$@"; do
    n="$(nc_native_holder "$p")"
    if [ -n "$n" ]; then real="${real:+$real }$p"; desc="${desc:+$desc, }$n on :$p"; else other="${other:+$other }$p"; fi
  done
  if [ -n "$real" ]; then
    nc_finding "$fw is filtering inbound traffic and does not allow port(s) $real ($desc), which a host process serves -- the panel cannot be reached from outside."
    note "Allow them:  $($fixfn $real)"
    [ -z "${NC_FIX_NOTE:-}" ] || note "$NC_FIX_NOTE"
  fi
  if [ -n "$other" ]; then
    note "$fw has no rule for port(s) $other. That does not block Tugra: its proxy and raw ports are published by Docker, which $fw's inbound rules do not filter. Only if a host program (not Docker) will listen there:  $($fixfn $other)"
  fi
}

nc_ports_csv() { local o="" p; for p in "$@"; do o="${o:+$o,}$p"; done; printf '%s' "$o"; }
nc_ports_cmds() { # <template with %P> <ports...> joined with " && "
  local t="$1" o="" p; shift
  for p in "$@"; do o="${o:+$o && }${t//%P/$p}"; done; printf '%s' "$o"
}

# Awk helper: does spec "80", "80/tcp", "80,443/tcp", "8000:9000", "3000-3001" cover port p?
NC_AWK_SPEC='
function covers(spec, p,    n, i, t, a, r) {
  spec = tolower(spec); gsub(/\(v6\)|[[:space:]]/, "", spec)
  if (spec ~ /\/udp/) return 0
  sub(/\/tcp/, "", spec)
  n = split(spec, t, ",")
  for (i = 1; i <= n; i++) {
    if (t[i] ~ /^[0-9]+$/) { if (t[i] + 0 == p) return 1 }
    else if (split(t[i], r, /[:-]/) == 2 && r[1] ~ /^[0-9]+$/ && r[2] ~ /^[0-9]+$/) { if (p >= r[1] + 0 && p <= r[2] + 0) return 1 }
  }
  return 0
}'

NC_FW_UNREADABLE=""   # names of the firewalls that are installed but could not be read (not root)

nc_fix_ufw() { nc_ports_cmds "$(nc_sudo)ufw allow %P/tcp" "$@"; }
nc_fw_ufw() { # ports...
  command -v ufw >/dev/null 2>&1 || return 1
  local out s allowed="" p blocked="" lc
  s="$(nc_sudo)"
  out="$(nc_t ufw status verbose 2>&1 || true)"
  case "$out" in
    *"Status: active"*) ;;
    *"Status: inactive"*) ok "ufw is installed but inactive (it filters nothing)"; return 1 ;;
    *) note "ufw is installed but its state could not be read (run as root:  ${s}ufw status verbose)"; NC_FW_UNREADABLE="${NC_FW_UNREADABLE:+$NC_FW_UNREADABLE, }ufw"; return 1 ;;
  esac
  lc="$(nc_lc "$out")"
  case "$lc" in *"allow (incoming)"*) ok "ufw is active with default incoming ALLOW (nothing is blocked)"; nc_docker_bypass_note; return 0 ;; esac
  # Only an inbound rule for any source counts: "ALLOW OUT" / "ALLOW FWD" rules and an "ALLOW IN" limited to a source CIDR do not open the port to the world.
  allowed="$(printf '%s\n' "$out" | awk -v want="$*" "$NC_AWK_SPEC"'
    BEGIN { n = split(want, W, " ") }
    /(ALLOW|LIMIT)/ && !/(ALLOW|LIMIT)[[:space:]]+(OUT|FWD)/ {
      spec = $0; sub(/[[:space:]]+(ALLOW|LIMIT).*/, "", spec)
      from = $0; sub(/.*(ALLOW|LIMIT)([[:space:]]+IN)?[[:space:]]+/, "", from)
      if (from !~ /^Anywhere/) next
      low = tolower(spec)
      for (i = 1; i <= n; i++) {
        p = W[i]
        if (low ~ /full/) { if (p == 80 || p == 443) hit[p] = 1 }
        else if (low ~ /(https|secure)/) { if (p == 443) hit[p] = 1 }
        else if (low ~ /(www|http)/) { if (p == 80) hit[p] = 1 }
        else if (covers(spec, p)) hit[p] = 1
      }
    }
    END { for (p in hit) printf "%s ", p }')"
  for p in "$@"; do case " $allowed " in *" $p "*) ;; *) blocked="${blocked:+$blocked }$p" ;; esac; done
  if [ -z "$blocked" ]; then ok "ufw is active and allows $(nc_ports_csv "$@")"
  else nc_fw_blocked "ufw" nc_fix_ufw $blocked
  fi
  nc_docker_bypass_note
  return 0
}

nc_fix_firewalld() { local s p; s="$(nc_sudo)"; printf '%sfirewall-cmd --permanent' "$s"; for p in "$@"; do printf ' --add-port=%s/tcp' "$p"; done; printf ' && %sfirewall-cmd --reload' "$s"; }
nc_fw_firewalld() { # ports...
  command -v firewall-cmd >/dev/null 2>&1 || return 1
  local st out allowed="" p blocked=""
  st="$(nc_t firewall-cmd --state 2>&1 || true)"
  case "$st" in running*) ;; *) return 1 ;; esac
  out="$(nc_t firewall-cmd --list-all 2>&1 || true)"
  allowed="$(printf '%s\n' "$out" | awk -v want="$*" '
    BEGIN { n = split(want, W, " ") }
    /^[[:space:]]*services:/ { sub(/^[[:space:]]*services:/, ""); m = split($0, S, " "); for (i = 1; i <= m; i++) { if (S[i] == "http") hit[80] = 1; if (S[i] == "https") hit[443] = 1 } }
    /^[[:space:]]*ports:/ { sub(/^[[:space:]]*ports:/, ""); m = split($0, S, " "); for (i = 1; i <= m; i++) { split(S[i], q, "/"); if (q[2] != "tcp") continue; if (q[1] ~ /-/) { split(q[1], r, "-"); for (j = 1; j <= n; j++) if (W[j] >= r[1] + 0 && W[j] <= r[2] + 0) hit[W[j]] = 1 } else hit[q[1] + 0] = 1 } }
    /^[[:space:]]*target:[[:space:]]*ACCEPT/ { all = 1 }
    END { if (all) { for (i = 1; i <= n; i++) printf "%s ", W[i] } else for (p in hit) printf "%s ", p }')"
  for p in "$@"; do case " $allowed " in *" $p "*) ;; *) blocked="${blocked:+$blocked }$p" ;; esac; done
  if [ -z "$blocked" ]; then ok "firewalld is running and allows $(nc_ports_csv "$@")"
  else nc_fw_blocked "firewalld" nc_fix_firewalld $blocked
  fi
  nc_docker_bypass_note
  return 0
}

nc_fix_nft() {
  local s; s="$(nc_sudo)"
  # `insert` puts the rule FIRST: `add` appends, and a trailing drop/reject rule would shadow it.
  printf '%snft insert rule inet filter input tcp dport { %s } accept' "$s" "$(nc_ports_csv "$@" | sed 's/,/, /g')"
}
nc_fw_nft() { # ports...
  command -v nft >/dev/null 2>&1 || return 1
  local out s res allowed="" p blocked=""
  s="$(nc_sudo)"
  out="$(nc_t nft list ruleset 2>&1 || true)"
  case "$out" in *"Operation not permitted"*|*"Permission denied"*|*"Error:"*) note "nftables is installed but its rules could not be read (run as root:  ${s}nft list ruleset)"; NC_FW_UNREADABLE="${NC_FW_UNREADABLE:+$NC_FW_UNREADABLE, }nftables"; return 1 ;; esac
  # Only an INPUT hook chain with a drop/reject policy filters inbound traffic; collect what its accept rules allow.
  res="$(printf '%s\n' "$out" | awk -v want="$*" "$NC_AWK_SPEC"'
    BEGIN { n = split(want, W, " ") }
    /^[[:space:]]*chain / { inchain = 1; isinput = 0 }
    /hook input/ { isinput = 1; found = 1; if ($0 ~ /policy (drop|reject)/) drop = 1 }
    isinput && /dport/ && /accept/ {
      spec = $0; sub(/.*dport/, "", spec); sub(/accept.*/, "", spec); gsub(/[{}]/, "", spec)
      for (i = 1; i <= n; i++) if (covers(spec, W[i])) hit[W[i]] = 1
    }
    /^[[:space:]]*}[[:space:]]*$/ { if (inchain) { inchain = 0; isinput = 0 } }
    END { printf "%s|%s|", (found ? "input" : "none"), (drop ? "drop" : "accept"); for (p in hit) printf "%s ", p }')"
  case "$res" in none\|*) return 1 ;; esac
  case "$res" in *"|accept|"*) ok "nftables: the input policy accepts traffic (nothing is blocked)"; return 0 ;; esac
  allowed="${res#*|*|}"
  for p in "$@"; do case " $allowed " in *" $p "*) ;; *) blocked="${blocked:+$blocked }$p" ;; esac; done
  if [ -z "$blocked" ]; then ok "nftables: the input chain allows $(nc_ports_csv "$@")"
  else
    NC_FIX_NOTE="(adjust 'inet filter input' to your table and chain: ${s}nft list ruleset; 'insert' puts the rule first so a trailing drop/reject cannot shadow it; make it permanent in /etc/nftables.conf)"
    nc_fw_blocked "nftables" nc_fix_nft $blocked
  fi
  return 0
}

nc_fix_iptables() {
  local s; s="$(nc_sudo)"
  printf '%siptables -I INPUT -p tcp -m multiport --dports %s -j ACCEPT' "$s" "$(nc_ports_csv "$@")"
}
nc_fw_iptables() { # ports...
  command -v iptables >/dev/null 2>&1 || return 1
  local out s res allowed="" p blocked="" chains
  s="$(nc_sudo)"
  out="$(nc_t iptables -S INPUT 2>&1 || true)"
  case "$out" in *"-P INPUT"*) ;; *) note "iptables is installed but its rules could not be read (run as root:  ${s}iptables -S INPUT)"; NC_FW_UNREADABLE="${NC_FW_UNREADABLE:+$NC_FW_UNREADABLE, }iptables"; return 1 ;; esac
  # Rules are first-match: an ACCEPT written AFTER a blanket REJECT/DROP never matches. A jump to a custom chain
  # (firewalld-direct, CSF, Imunify, fail2ban ...) hides what it accepts, so a port that is not accepted in INPUT itself is "unknown", not "blocked".
  res="$(printf '%s\n' "$out" | awk -v want="$*" "$NC_AWK_SPEC"'
    BEGIN { n = split(want, W, " ") }
    /^-P INPUT / { if ($3 == "DROP" || $3 == "REJECT") blocking = 1 }
    /^-A INPUT / {
      if ($0 ~ /^-A INPUT -j (DROP|REJECT)/) { blocking = 1; sealed = 1; next }
      if (sealed) next
      if (match($0, / -j [^ ]+/)) {
        tgt = substr($0, RSTART + 4, RLENGTH - 4)
        if (tgt !~ /^(ACCEPT|DROP|REJECT|RETURN|LOG|ULOG|NFLOG|TRACE|MARK|CONNMARK|TCPMSS|CT|NOTRACK|SECMARK|CONNSECMARK|AUDIT)$/) { custom = custom (custom == "" ? "" : ", ") tgt }
      }
      if ($0 ~ /-j ACCEPT/ && $0 ~ /-p tcp/ && $0 !~ / -i lo( |$)/ && ($0 !~ / -s / || $0 ~ / -s 0\.0\.0\.0\/0( |$)/)) {
        spec = ""
        if (match($0, /--dports? [0-9,:]+/)) { spec = substr($0, RSTART, RLENGTH); sub(/--dports? /, "", spec) }
        if (spec != "") for (i = 1; i <= n; i++) if (covers(spec, W[i])) hit[W[i]] = 1
      }
      if ($0 ~ /^-A INPUT -j ACCEPT$/) allall = 1
    }
    END { printf "%s|%s|", (blocking && !allall ? "block" : "open"), custom; for (p in hit) printf "%s ", p }')"
  case "$res" in open\|*) ok "iptables: the INPUT chain does not block inbound traffic"; return 0 ;; esac
  chains="${res#block|}"; chains="${chains%%|*}"
  allowed="${res##*|}"
  for p in "$@"; do case " $allowed " in *" $p "*) ;; *) blocked="${blocked:+$blocked }$p" ;; esac; done
  if [ -z "$blocked" ]; then ok "iptables: the INPUT chain allows $(nc_ports_csv "$@")"
  elif [ -n "$chains" ]; then
    note "iptables: the INPUT policy is DROP/REJECT and the chain hands traffic to other chains ($chains), which this check cannot follow, so port(s) $blocked may or may not be allowed there. Verify:  ${s}iptables -S $(printf '%s' "$chains" | cut -d, -f1)"
  else
    NC_FIX_NOTE="(-I puts it first, so it is not shadowed by a blanket REJECT; persist it with ${s}netfilter-persistent save, or ${s}service iptables save on RHEL)"
    nc_fw_blocked "iptables" nc_fix_iptables $blocked
  fi
  nc_docker_bypass_note
  return 0
}

# Host firewall verdict for the given ports. The first active manager owns the answer (ufw and firewalld program nftables
# underneath, so the lower layers would only repeat it).
nc_firewall() { # ports...
  NC_FW_UNREADABLE=""; NC_FIX_NOTE=""
  nc_fw_ufw "$@" && return 0
  nc_fw_firewalld "$@" && return 0
  nc_fw_nft "$@" && return 0
  nc_fw_iptables "$@" && return 0
  if [ -n "$NC_FW_UNREADABLE" ]; then
    # Installed but not readable (not root): that is "unknown", never "no firewall in the way".
    note "Host firewall: UNKNOWN -- $NC_FW_UNREADABLE is installed but could not be read as this user. Run as root for a verdict:  $(nc_sudo)./scripts/install.sh --doctor"
    return 0
  fi
  ok "No host firewall in the way (no active ufw, firewalld, nftables or iptables filtering)"
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
# 3. Hosting provider (local files only, no network)
# ---------------------------------------------------------------------------------------------------------------------

# Sets NC_CLOUD (slug) and NC_CLOUD_NAME from DMI, cloud-init and the hostname; "" when it is not a recognised provider.
nc_cloud_detect() {
  local d="$NC_DMI" blob cid ds host
  NC_CLOUD=""; NC_CLOUD_NAME=""
  blob="$(nc_lc "$(nc_first_line "$d/sys_vendor") | $(nc_first_line "$d/product_name") | $(nc_first_line "$d/bios_vendor") | $(nc_first_line "$d/chassis_vendor") | $(nc_first_line "$d/board_vendor") | $(nc_first_line "$d/product_version") | $(nc_first_line "$d/chassis_asset_tag")")"
  cid="$(nc_lc "$(nc_first_line "$NC_FS/run/cloud-init/cloud-id")")"
  ds="$(nc_lc "$(nc_first_line "$NC_FS/var/lib/cloud/instance/datasource")")"
  host="$(nc_lc "${TUGRA_HOSTNAME:-$(hostname 2>/dev/null || true)}")"
  case "$cid" in
    hetzner) NC_CLOUD=hetzner ;; aws|ec2) NC_CLOUD=aws ;; gce|gcp) NC_CLOUD=gcp ;; azure) NC_CLOUD=azure ;;
    digitalocean) NC_CLOUD=digitalocean ;; vultr) NC_CLOUD=vultr ;; linode|akamai) NC_CLOUD=linode ;;
    oracle|oci) NC_CLOUD=oracle ;; scaleway) NC_CLOUD=scaleway ;; ovh) NC_CLOUD=ovh ;; contabo) NC_CLOUD=contabo ;;
  esac
  if [ -z "$NC_CLOUD" ]; then
    case "$ds" in
      *hetzner*) NC_CLOUD=hetzner ;; *ec2*) NC_CLOUD=aws ;; *gce*) NC_CLOUD=gcp ;; *azure*) NC_CLOUD=azure ;;
      *digitalocean*) NC_CLOUD=digitalocean ;; *vultr*) NC_CLOUD=vultr ;; *linode*) NC_CLOUD=linode ;;
      *oracle*) NC_CLOUD=oracle ;; *scaleway*) NC_CLOUD=scaleway ;; *ovh*) NC_CLOUD=ovh ;;
    esac
  fi
  if [ -z "$NC_CLOUD" ]; then
    case "$blob" in
      *hetzner*) NC_CLOUD=hetzner ;;
      *amazon*) NC_CLOUD=aws ;;
      *"google compute engine"*|"google | "*) NC_CLOUD=gcp ;;
      *digitalocean*) NC_CLOUD=digitalocean ;;
      *vultr*) NC_CLOUD=vultr ;;
      *linode*|*akamai*) NC_CLOUD=linode ;;
      *oraclecloud*|*"oracle cloud"*) NC_CLOUD=oracle ;;
      *scaleway*) NC_CLOUD=scaleway ;;
      *ovh*) NC_CLOUD=ovh ;;
      *contabo*) NC_CLOUD=contabo ;;
      *7783-7084-3265-9085-8269-3286-77*) NC_CLOUD=azure ;;
    esac
  fi
  if [ -z "$NC_CLOUD" ]; then case "$host" in vmi[0-9]*) NC_CLOUD=contabo ;; esac; fi
  if [ -z "$NC_CLOUD" ]; then
    case "$blob" in *qemu*|*kvm*|*seabios*|*"standard pc"*|*"bochs"*|*"red hat"*|*"openstack"*) NC_CLOUD=kvm ;; esac
  fi
  case "$NC_CLOUD" in
    hetzner) NC_CLOUD_NAME="Hetzner" ;; aws) NC_CLOUD_NAME="AWS (EC2)" ;; gcp) NC_CLOUD_NAME="Google Cloud" ;;
    azure) NC_CLOUD_NAME="Microsoft Azure" ;; digitalocean) NC_CLOUD_NAME="DigitalOcean" ;; vultr) NC_CLOUD_NAME="Vultr" ;;
    linode) NC_CLOUD_NAME="Linode / Akamai Cloud" ;; oracle) NC_CLOUD_NAME="Oracle Cloud" ;; scaleway) NC_CLOUD_NAME="Scaleway" ;;
    ovh) NC_CLOUD_NAME="OVHcloud" ;; contabo) NC_CLOUD_NAME="Contabo" ;; kvm) NC_CLOUD_NAME="a KVM/QEMU virtual server (provider not recognised)" ;;
  esac
  return 0
}

# Hosting provider and its cloud-firewall hint for the given ports (a note, never a failure: it cannot be read from here).
nc_cloud() { # ports...
  local pcsv pc; pcsv="$(nc_ports_csv "$@")"; pc="${pcsv//,/, }"
  nc_cloud_detect
  if [ -z "$NC_CLOUD" ]; then
    ok "Hosting: no cloud provider recognised (bare metal, a home server or an unlisted host)"
    note "If your provider filters inbound traffic (a security group / firewall in its control panel), allow TCP $pc there."
    return 0
  fi
  ok "Hosting: $NC_CLOUD_NAME"
  case "$NC_CLOUD" in
    hetzner)      note "Cloud firewall: Hetzner Cloud Console -> your project -> Firewalls -> the firewall attached to this server -> Inbound rules: allow TCP $pc (a server without a firewall attached is not filtered)." ;;
    aws)          note "Cloud firewall: AWS Console -> EC2 -> Security Groups -> the group on this instance -> Inbound rules: add HTTP (80) and HTTPS (443) from 0.0.0.0/0 and ::/0. Also check the subnet's Network ACL." ;;
    gcp)          note "Cloud firewall: Google Cloud Console -> VPC network -> Firewall: an ingress rule allowing tcp:$pcsv (target: this VM's network tag), or tick 'Allow HTTP/HTTPS traffic' on the VM." ;;
    azure)        note "Cloud firewall: Azure Portal -> this VM -> Networking -> the Network security group -> Inbound security rules: add TCP $pc." ;;
    digitalocean) note "Cloud firewall: DigitalOcean Control Panel -> Networking -> Firewalls -> the one applied to this Droplet -> Inbound Rules: HTTP (80) and HTTPS (443)." ;;
    vultr)        note "Cloud firewall: Vultr Customer Portal -> Products -> Firewall -> the group attached to this instance: add TCP $pc. Vultr images often ship ufw enabled as well (checked above)." ;;
    linode)       note "Cloud firewall: Linode/Akamai Cloud Manager -> Firewalls -> the firewall assigned to this Linode -> Inbound Rules: allow TCP $pc." ;;
    oracle)       note "Cloud firewall: OCI Console -> Networking -> the VCN's Security List (or Network Security Group) -> Ingress Rules: TCP $pc from 0.0.0.0/0. Oracle's Ubuntu/Oracle Linux images also ship host iptables rules that reject everything else (checked above)." ;;
    scaleway)     note "Cloud firewall: Scaleway Console -> Instances -> Security Groups -> the group of this server -> Inbound rules: allow TCP $pc." ;;
    ovh)          note "Cloud firewall: OVHcloud -> Public Cloud Security Groups (or Network -> IP -> Edge Network Firewall for this IP): allow TCP $pc." ;;
    contabo)      note "Cloud firewall: a plain Contabo VPS has no provider firewall unless you attached one (Customer Control Panel -> VPS -> Firewall); the host firewall above is what filters." ;;
    kvm)          note "Open TCP $pc wherever your provider filters inbound traffic (its control panel's firewall / security group)." ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
# 4. IPv6 / AAAA
# ---------------------------------------------------------------------------------------------------------------------

# Expand an IPv6 address to 32 lowercase hex digits (so "2a01:4f8::1" and "2a01:04f8:0:0:0:0:0:1" compare equal).
nc_v6_norm() {
  awk -v a="$1" 'BEGIN {
    a = tolower(a); sub(/%.*/, "", a)
    nl = 0; nr = 0
    if (index(a, "::")) { i = index(a, "::"); left = substr(a, 1, i - 1); right = substr(a, i + 2); if (left != "") nl = split(left, L, ":"); if (right != "") nr = split(right, R, ":") }
    else { nl = split(a, L, ":") }
    out = ""
    for (i = 1; i <= nl; i++) out = out substr("0000" L[i], length(L[i]) + 1)
    if (index(a, "::")) { for (i = 0; i < 8 - nl - nr; i++) out = out "0000"; for (i = 1; i <= nr; i++) out = out substr("0000" R[i], length(R[i]) + 1) }
    print out
  }'
}

# Global IPv6 addresses of this host that can sit in an AAAA record, one per line, 32 hex digits each.
# /proc/net/if_inet6 is "addr ifindex plen scope flags name"; scope 00 = global. Not counted: unique-local fc00::/7
# (Tailscale/WireGuard/Docker ULAs are not routable from the internet), and temporary / deprecated / tentative / failed
# addresses (privacy addresses are outgoing-only). The interface of the IPv6 default route is preferred when there is one.
nc_default_v6_iface() {
  [ -r "$NC_FS/proc/net/ipv6_route" ] || return 0
  awk '$1 == "00000000000000000000000000000000" && $2 == "00" { print $10; exit }' "$NC_FS/proc/net/ipv6_route" 2>/dev/null || true
}
nc_local_ipv6() {
  [ -r "$NC_FS/proc/net/if_inet6" ] || return 0
  local ifc; ifc="$(nc_default_v6_iface)"
  awk -v ifc="$ifc" '
    function hexv(h,    i, c, v) { v = 0; h = tolower(h); for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", substr(h, i, 1)) - 1; v = v * 16 + c } return v }
    function has(v, bit) { return int(v / bit) % 2 == 1 }
    $4 == "00" {
      a = tolower($1)
      if (a ~ /^f[cd]/) next
      f = hexv($5)
      if (has(f, 1) || has(f, 8) || has(f, 32) || has(f, 64)) next
      all[++n] = a; nm[n] = $6
    }
    END {
      if (ifc != "") for (i = 1; i <= n; i++) if (nm[i] == ifc) { print all[i]; found = 1 }
      if (!found) for (i = 1; i <= n; i++) print all[i]
    }' "$NC_FS/proc/net/if_inet6" 2>/dev/null || true
}
nc_v6_pretty() { awk -v a="$1" 'BEGIN { for (i = 1; i <= 29; i += 4) { g = substr(a, i, 4); sub(/^0+/, "", g); if (g == "") g = "0"; printf "%s%s", (i > 1 ? ":" : ""), g } }'; }

_nc_resolve_aaaa() {
  local h="$1" out=""
  if command -v getent >/dev/null 2>&1; then out="$(nc_t getent ahostsv6 "$h" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  elif command -v dig >/dev/null 2>&1; then out="$(nc_t dig +short +time=3 +tries=1 AAAA "$h" 2>/dev/null | grep -E '^[0-9a-fA-F:]+$' | sort -u || true)"
  elif command -v host >/dev/null 2>&1; then out="$(nc_t host -W 3 -t AAAA "$h" 2>/dev/null | awk '/has IPv6 address/{print $NF}' | sort -u || true)"
  fi
  # getent returns IPv4-mapped answers (::ffff:1.2.3.4) for an A-only name: those are not AAAA records
  printf '%s\n' "$out" | grep -E ':' | grep -viE '^::ffff:' || true
}

nc_ipv6() { # [domain]
  local dom="${1:-}" local6 aaaa="" a v mine=0 cf=0 firstlocal other=""
  dom="$(printf '%s' "$dom" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#[/:].*$##')"
  local6="$(nc_local_ipv6)"
  [ -z "$dom" ] || aaaa="$(_nc_resolve_aaaa "$dom")"
  if [ -n "$aaaa" ]; then
    for a in $aaaa; do
      if is_cloudflare_ip6 "$a"; then cf=1; continue; fi
      v="$(nc_v6_norm "$a")"
      if [ -n "$local6" ] && grep -qxF "$v" <<<"$local6"; then mine=1; else other="${other:+$other }$a"; fi
    done
  fi
  if [ -n "$local6" ]; then
    firstlocal="$(nc_v6_pretty "$(printf '%s\n' "$local6" | head -n1)")"
    ok "IPv6: this host has a global address ($firstlocal)"
    if [ -n "$dom" ] && [ -n "$aaaa" ]; then
      if [ -n "$other" ]; then
        nc_warn_counted "$dom has an AAAA record ($other) that is NOT this host's IPv6. Browsers and Let's Encrypt try IPv6 first, so the panel and its certificate fail for them."
        note "Fix: point the AAAA record at this host's IPv6 ($firstlocal) or delete it. Also allow TCP 80/443 for IPv6 in the cloud firewall."
      elif [ "$mine" = "1" ]; then ok "$dom's AAAA record points at this host"
      else ok "$dom's AAAA record is a Cloudflare address (proxied): fine"; fi
    elif [ -n "$dom" ]; then
      note "$dom has no AAAA record: IPv4 only, which is fine. To also serve IPv6, add an AAAA record for $firstlocal and allow TCP 80/443 for IPv6 in the cloud firewall."
    else
      note "Once the domain has an AAAA record Tugra answers on IPv6 too: allow TCP 80/443 for IPv6 in the cloud firewall. A stale AAAA that points elsewhere breaks HTTPS for IPv6 clients."
    fi
  else
    ok "IPv6: none on this host (IPv4 only)"
    if [ -n "$dom" ] && [ -n "$other" ]; then
      nc_warn_counted "$dom has an AAAA record ($other) but this host has no IPv6. Let's Encrypt and browsers try IPv6 first, so the certificate and the panel fail."
      note "Fix: delete $dom's AAAA record (keep only the A record), or give this host that IPv6 address."
    fi
  fi
  return 0
}
# Cloudflare's IPv6 edge ranges all start with these prefixes (https://www.cloudflare.com/ips-v6; 2a06:98c0::/29 is 98c0-98c7).
is_cloudflare_ip6() {
  case "$(nc_lc "$1")" in 2400:cb00:*|2606:4700:*|2803:f800:*|2405:b500:*|2405:8100:*|2a06:98c[0-7]:*|2c0f:f248:*) return 0 ;; esac
  return 1
}

# ---------------------------------------------------------------------------------------------------------------------
# Install preflight: everything above, advisory only
# ---------------------------------------------------------------------------------------------------------------------
# What an existing install is: "none" (no .env yet), "tls" (bundled HTTPS for PANEL_DOMAIN), "ip" (panel on http://<ip>/ through
# Tugra's proxy), "byo" (the operator's own proxy fronts it: a trusted-proxy / https install without Tugra's proxy; the raw
# ports are on loopback and :80/:443 belong to that proxy) or "raw" (hub/web published on HUB_PORT/WEB_PORT). Sets NC_INSTALL_KIND.
nc_install_kind() {
  NC_INSTALL_KIND=none
  [ -s "${ENV_FILE:-/nonexistent}" ] || return 0
  if [ "$(nc_env PANEL_TLS)" = "1" ] && [ -n "$(nc_env PANEL_DOMAIN)" ]; then NC_INSTALL_KIND=tls
  elif [ "$(nc_env PANEL_IP_ROUTE)" = "1" ]; then NC_INSTALL_KIND=ip
  elif [ "$(nc_env HUB_TRUSTED_PROXY)" = "true" ]; then NC_INSTALL_KIND=byo
  else case "$(nc_env HUB_PUBLIC_URL)" in https://*) NC_INSTALL_KIND=byo ;; *) NC_INSTALL_KIND=raw ;; esac
  fi
}

nc_preflight() {
  local ports="80 443" p raw=0 hp wp
  NC_STRICT=0; NC_LAST_ADVICE=""; NC_BYO=0; NC_WARN_COUNTS=0
  hp="${HUB_PORT:-3000}"; wp="${WEB_PORT:-3001}"
  nc_install_kind
  case "$NC_INSTALL_KIND" in
    raw) raw=1 ;;
    byo) NC_BYO=1 ;;
    none)
      # A fresh install: the raw hub/web ports are what it will publish only when it ends up in raw-port mode
      # (--raw-ports, explicit --hub-url/--web-url, or a no-domain install that finds :80 taken); a --domain install keeps them on loopback.
      if [ -z "${DOMAIN:-}" ]; then
        if [ "${RAW_PORTS:-0}" = "1" ] || [ -n "${HUB_URL:-}" ] || [ -n "${WEB_URL:-}" ]; then raw=1
        elif declare -F foreign_port_busy >/dev/null 2>&1 && foreign_port_busy 80; then raw=1; fi
      elif [ "${AUTO_TLS:-}" = "0" ]; then NC_BYO=1; fi ;;
  esac
  # An installed raw-port hub does not use 80/443 and an upgrade keeps it that way.
  if [ "$NC_INSTALL_KIND" != "raw" ]; then for p in 80 443; do nc_port_check "$p" proxy || true; done; fi
  # The raw hub/web ports are checked in every mode (an upgrade re-run keeps them).
  for p in "$hp" "$wp"; do nc_port_check "$p" raw || true; done
  # The ports somebody has to be able to reach: 80/443 for the proxy, or only the raw ports in raw-port mode.
  if [ "$raw" = "1" ]; then ports="$hp $wp"; fi
  # shellcheck disable=SC2086
  nc_firewall $ports || true
  # shellcheck disable=SC2086
  nc_cloud $ports || true
  nc_ipv6 "${DOMAIN:-}" || true
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
# `install.sh --doctor`
# ---------------------------------------------------------------------------------------------------------------------
nc_loop_host() { # <bind> -> the address to probe the hub/web on from this host
  local b; b="$(printf '%s' "$1" | tr -d "\"' \r")"
  case "$b" in ""|0.0.0.0|"::"|"[::]") printf '127.0.0.1' ;; *:*) b="${b#[}"; b="${b%]}"; printf '[%s]' "$b" ;; *) printf '%s' "$b" ;; esac
}
nc_env() { env_get "$1" | tr -d "\"' \r"; }

# Epoch seconds of a `docker logs --timestamps` line ("2026-11-23T12:00:00.123456789Z ..."), "" when it cannot be read.
nc_line_epoch() {
  local t="${1%% *}" b
  b="${t%%.*}"; b="${b%Z}"
  date -u -d "${b}Z" +%s 2>/dev/null || TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "$b" +%s 2>/dev/null || true
}

nc_doctor() {
  local kind="" pd="" have_env=0 proxied=0 ports="80 443" p svc line state health rc docker_ok=0
  local compose_up="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"
  log "Tugra doctor -- read-only: nothing on this host is changed"
  NC_PROBLEMS=0; NC_LAST_ADVICE=""; NC_BYO=0
  [ -s "$ENV_FILE" ] && have_env=1
  NC_WARN_COUNTS=$have_env
  nc_install_kind
  if [ "$have_env" = "1" ]; then kind="$NC_INSTALL_KIND"; pd="$(nc_env PANEL_DOMAIN)"; else pd="${DOMAIN:-}"; fi
  if [ "$kind" = "ip" ] || [ "$kind" = "tls" ]; then proxied=1; fi
  [ "$kind" != "byo" ] || NC_BYO=1

  printf '\n'; log "Host"
  if [ "$(id -u 2>/dev/null || echo 1)" != "0" ]; then
    note "Not running as root: process names behind a port and firewall rules may be hidden, and a firewall that cannot be read is reported as unknown. For the full picture:  sudo ./scripts/install.sh --doctor"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    nc_problem "Docker is not installed."; note "Fix: run ./scripts/install.sh (it installs Docker) or https://get.docker.com"
  elif ! nc_t docker info >/dev/null 2>&1; then
    nc_problem "Docker is installed but its daemon is not reachable (stopped, or you are not root / in the docker group)."; note "Fix:  $(nc_sudo)systemctl start docker  (and run this as root or add your user to the docker group)"
  else
    docker_ok=1
    ok "Docker $(nc_t docker version --format '{{.Server.Version}}' 2>/dev/null || echo present) (daemon running)"
    if nc_t docker compose version >/dev/null 2>&1; then ok "Docker Compose v2 plugin"; else nc_problem "Docker Compose v2 plugin is missing."; note "Fix: install docker-compose-plugin (https://docs.docker.com/compose/install/linux/)"; fi
  fi
  local freeg; freeg="$( { df -Pm "${REPO_DIR:-.}" 2>/dev/null || true; } | awk 'NR==2{print int(($4+512)/1024)}' )"
  if [ -n "${freeg:-}" ]; then
    if [ "$freeg" -lt 2 ]; then nc_problem "Free disk: ~${freeg}GB -- Tugra and its images need more."; note "Fix: free space (docker image prune, docker system df shows what takes it), or run ./scripts/install.sh --prune-images"
    elif [ "$freeg" -lt 5 ]; then note "Free disk: ~${freeg}GB -- 10GB+ recommended (images + volumes)"
    else ok "Free disk: ~${freeg}GB"; fi
  fi

  printf '\n'; log "Ports"
  local hp wp; hp="$(nc_env HUB_PORT)"; wp="$(nc_env WEB_PORT)"; hp="${hp:-${HUB_PORT:-3000}}"; wp="${wp:-${WEB_PORT:-3001}}"
  # 80/443 only matter (a red cross) when the panel is served through Tugra's proxy; the raw ports when Tugra is installed.
  # A raw-port install does not use 80/443 at all.
  NC_STRICT=$proxied
  if [ "$kind" != "raw" ]; then for p in 80 443; do nc_port_check "$p" proxy || true; done; fi
  NC_STRICT=$have_env
  for p in "$hp" "$wp"; do nc_port_check "$p" raw || true; done
  # A blocked port is a finding only for a host process that serves it (a bring-your-own proxy); Tugra's own ports are Docker-published.
  NC_STRICT=$have_env
  # The ports somebody has to reach from outside: the raw hub/web ports for a raw install, 80/443 otherwise (a
  # bring-your-own-proxy install keeps the raw ports on loopback).
  if [ "$kind" = "raw" ]; then ports="$hp $wp"; fi

  printf '\n'; log "Firewall"
  # shellcheck disable=SC2086
  nc_firewall $ports || true

  printf '\n'; log "Hosting"
  # shellcheck disable=SC2086
  nc_cloud $ports || true

  printf '\n'; log "Addresses & DNS"
  local pubip; pubip="$(nc_env LOCAL_SERVER_PUBLIC_IP)"; pubip="${pubip:-${MANUAL_PUBLIC_IP:-}}"
  local lip; lip="$(_local_ip)"
  if [ -n "$lip" ]; then
    if [ -z "$pubip" ] && is_private_ipv4 "$lip"; then warn_private_ip "$lip"  # a LAN-only install is legitimate: advice, not a failure
    else ok "Address: ${pubip:-$lip}"; fi
  else
    note "Could not read this host's IPv4 address (hostname -I / ip route)."
  fi
  nc_ipv6 "$pd" || true
  if [ "$kind" = "tls" ] && [ -n "$pd" ]; then
    # DNS + Cloudflare advice is the installer's own check: reused as is.
    panel_dns_preflight "$pd" "$([ -n "$(nc_env ACME_DNS_TOKEN)" ] && echo 1 || echo 0)" "$pubip" || true
  fi

  printf '\n'; log "Tugra"
  if [ "$have_env" = "0" ]; then
    note "Tugra is not installed here (no $ENV_FILE). Run ./scripts/install.sh to install it; the checks above are what it will find."
  else
    ok "Install: $kind mode${pd:+ ($pd)}, version $(nc_env TUGRA_VERSION)"
    local acid=""   # the agent container (compose's, or the self-updated tugra-agent-1 that compose does not know)
    if [ "$docker_ok" != "1" ]; then
      note "Skipping the container checks (Docker is not reachable)."
    else
      local ps; ps="$(nc_t docker compose --profile updater --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null || true)"
      [ -n "$ps" ] || note "Could not list the containers (docker compose ps)  ·  try:  $compose_up ps"
      for svc in postgres redis hub-api web agent; do
        [ -n "$ps" ] || break
        line="$(printf '%s\n' "$ps" | grep -E "^${svc}\|" | head -n1 || true)"
        if [ -z "$line" ] && [ "$svc" = "agent" ]; then
          # "Update agent" recreates the agent with a plain `docker run` as tugra-agent-1, without compose labels: compose does not list it.
          state="$(nc_t docker ps -a --filter 'name=^/tugra-agent-1$' --format '{{.State}}' 2>/dev/null | head -n1 || true)"
          if [ -n "$state" ]; then
            acid="tugra-agent-1"
            if [ "$state" = "running" ]; then ok "Container agent: running as tugra-agent-1 (self-updated, outside docker compose; the next ./scripts/install.sh run hands it back to compose)"
            else nc_problem "Container agent (tugra-agent-1, outside docker compose): $state."; note "Fix:  docker start tugra-agent-1  ·  or re-run ./scripts/install.sh (it replaces it with the compose-managed one)"; fi
            continue
          fi
        fi
        state="$(printf '%s' "$line" | cut -d'|' -f2)"; health="$(printf '%s' "$line" | cut -d'|' -f3)"
        if [ -z "$line" ]; then nc_problem "Container $svc: not created."; note "Fix:  $compose_up up -d $svc   (or re-run ./scripts/install.sh)"
        elif [ "$state" != "running" ]; then nc_problem "Container $svc: $state."; note "Fix:  $compose_up up -d $svc   · why:  $compose_up logs --tail 50 $svc"
        elif [ "$health" = "unhealthy" ]; then nc_problem "Container $svc is running but unhealthy."; note "Why:  $compose_up logs --tail 50 $svc"
        elif [ "$health" = "starting" ]; then note "Container $svc is still starting."
        else ok "Container $svc: running${health:+ ($health)}"; [ "$svc" != "agent" ] || acid="$(nc_t docker compose --profile updater --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q agent 2>/dev/null | head -n1 || true)"; fi
      done
      if [ "$kind" = "ip" ] || [ "$kind" = "tls" ]; then
        if [ -n "$(nc_t docker ps -q --filter 'name=^/tugra-proxy$' 2>/dev/null || true)" ]; then ok "Container tugra-proxy: running (the panel proxy)"
        else nc_problem "Container tugra-proxy is not running -- the panel is not served on :80/:443."; note "Fix: re-run ./scripts/install.sh (it recreates the proxy)  ·  why:  docker logs tugra-proxy  ·  is another service on :80? (see Ports above)"; fi
      fi
    fi
    # Reachability on loopback: the hub directly, then the real path through the proxy (routes).
    if ! command -v curl >/dev/null 2>&1; then
      note "curl is not installed, so the panel URL could not be probed."
    else
      local hh; hh="$(nc_loop_host "$(nc_env HUB_BIND)")"
      if nc_t curl -fsS --max-time 5 -o /dev/null "http://$hh:$hp/health" >/dev/null 2>&1; then ok "Hub answers on http://$hh:$hp/health"
      else nc_problem "The hub does not answer on http://$hh:$hp/health."; note "Fix:  $compose_up logs --tail 50 hub-api  ·  then  $compose_up up -d hub-api"; fi
      if [ "$kind" = "ip" ]; then
        if nc_t curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1/health" >/dev/null 2>&1; then ok "Proxy route / host-less -> hub: http://127.0.0.1/health answers"
        else nc_problem "The proxy does not route http://127.0.0.1/health to the hub."; note "Fix: re-run ./scripts/install.sh  ·  why:  docker logs tugra-proxy"; fi
        if nc_t curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1/" >/dev/null 2>&1; then ok "Proxy route / -> web: http://127.0.0.1/ answers"
        else nc_problem "The proxy does not route http://127.0.0.1/ to the web UI."; note "Fix: re-run ./scripts/install.sh  ·  why:  docker logs tugra-proxy"; fi
      elif [ "$kind" = "tls" ]; then
        if nc_t curl -fsSk --max-time 5 --resolve "$pd:443:127.0.0.1" -o /dev/null "https://$pd/health" >/dev/null 2>&1; then ok "Proxy route https://$pd/health -> hub answers (via 127.0.0.1)"
        else nc_problem "The proxy does not answer https://$pd/health on 127.0.0.1."; note "Fix: re-run ./scripts/install.sh  ·  why:  docker logs tugra-proxy"; fi
        # Without -k: a certificate Traefik could not issue yet falls back to its self-signed default, which fails verification (curl 60).
        rc=0; nc_t curl -fsS --max-time 5 --resolve "$pd:443:127.0.0.1" -o /dev/null "https://$pd/health" >/dev/null 2>&1 || rc=$?
        if [ "$rc" = "0" ]; then
          ok "Certificate for $pd is present and trusted$(nc_cert_expiry "$pd")"
        else
          nc_problem "No valid certificate for $pd (curl exit $rc): the proxy is serving its self-signed default."
          note "Why: the certificate issues when Let's Encrypt can reach this host over :80 -- DNS A record -> this server, :80/:443 open (Firewall/Hosting above), and behind Cloudflare SSL/TLS mode 'Full' with 'Always Use HTTPS' off for the first issue."
          note "Look:  docker logs tugra-proxy 2>&1 | grep -i acme  ·  then re-run ./scripts/install.sh"
        fi
      else
        if nc_t curl -fsS --max-time 5 -o /dev/null "http://$(nc_loop_host "$(nc_env WEB_BIND)"):$wp/" >/dev/null 2>&1; then ok "Web UI answers on port $wp"
        else nc_problem "The web UI does not answer on port $wp."; note "Fix:  $compose_up up -d web  ·  why:  $compose_up logs --tail 50 web"; fi
      fi
    fi
    # Agent: connected = its recent log has no connection failure after the last good session (a successful connect logs
    # "hub session on <url> established"; older agents log nothing on success, so an old failure line proves nothing).
    if [ "$docker_ok" = "1" ] && [ -n "$acid" ]; then
      local alog last now ep
      alog="$(nc_t docker logs --timestamps --tail 60 "$acid" 2>&1 || true)"
      last="$(printf '%s\n' "$alog" | grep -E 'no hub endpoint reachable|hub endpoint [^ ]+:|hub session on|rejected|unauthorized|invalid token' | tail -n1 || true)"
      case "$last" in
        "") ok "Local agent: running, no connection errors in its log (the 'This machine' server should show Online)" ;;
        *"hub session on"*"established"*) ok "Local agent: connected to the hub (the 'This machine' server should show Online)" ;;
        *"hub session on"*) ok "Local agent: running; its last log event is a finished hub session with no failed reconnect after it (the 'This machine' server should show Online)" ;;
        *)
          ep="$(nc_line_epoch "$last")"; now="$(date +%s 2>/dev/null || true)"
          if [ -n "$ep" ] && [ -n "$now" ] && [ $((now - ep)) -gt 180 ]; then
            ok "Local agent: running; the last connection error in its log is $(( (now - ep) / 60 )) min old and nothing failed since (an agent that predates the 'established' log line says nothing when it reconnects)"
          else
            nc_problem "Local agent is not connected to the hub: ${last#* }"
            note "Fix:  $compose_up restart agent  ·  a rejected/invalid token means the enroll token changed: re-run ./scripts/install.sh  ·  log:  docker logs --tail 50 $acid"
          fi ;;
      esac
    fi
  fi

  printf '\n'
  if [ "$NC_PROBLEMS" -eq 0 ]; then
    log "Doctor: no problems found."
    return 0
  fi
  err "Doctor: $NC_PROBLEMS problem(s) found -- the fix for each is printed under its red cross above."
  return 1
}

# Best-effort " (expires <date>)" from the certificate the proxy serves on loopback; "" without openssl.
nc_cert_expiry() { # <domain>
  command -v openssl >/dev/null 2>&1 || return 0
  local end
  end="$(printf '' | nc_t openssl s_client -connect 127.0.0.1:443 -servername "$1" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//' || true)"
  [ -z "$end" ] || printf ' (expires %s)' "$end"
}
