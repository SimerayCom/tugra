#!/usr/bin/env bash
# RAM profiles for the hub stack. Sourced by install.sh (needs its ok/note/warn/err helpers and set_env/ensure_env/env_get).
#
# The hub must run on a 1 vCPU / 1 GB host as well as on a big one, so the installer sizes the stack from the detected RAM:
#
#   tiny      MemTotal <  1.5 GiB   (a "1 GB" VM)
#   small     MemTotal <  3 GiB     (a "2 GB" VM)
#   standard  MemTotal >= 3 GiB     (a "4 GB" VM and up; also what an unknown RAM size gets)
#
# The choice is persisted as TUGRA_PROFILE in .env, together with the values it implies (one key per knob, all read by
# deploy/docker-compose.yml with a `${KEY:-default}` fallback). Nothing here is required: an install that never ran this
# (TUGRA_PROFILE and every key below absent) gets the compose defaults, which equal the `standard` profile's behaviour or
# better, so an in-app update of an existing install keeps working untouched.
#
#   --profile=<tiny|small|standard|auto>   pick the profile (auto = detect again from this host's RAM). Overrides what .env has.
#   no flag, TUGRA_PROFILE in .env         keep it (the operator's hand edits of the keys below survive a re-run).
#   no flag, no TUGRA_PROFILE              detect from RAM and write it; a key that is already in .env is never overwritten.
#
# What each knob does, and why it is safe:
#   HUB_MAX_HEAP_MB / HUB_SEMI_SPACE_MB / HUB_MALLOC_ARENA_MAX  V8 old-space cap, young-generation size and glibc malloc arenas
#                      of hub-api (NODE_OPTIONS + env). A cap turns a burst into GC work instead of RSS growth; a heap cap that is
#                      too low is a fatal abort, so each value is >= 2x the heap the fleet load harness peaks at (docs/install.md).
#   WEB_MAX_HEAP_MB    the same for the Next server (a proxy + SSR: tens of MB of real heap).
#   TUGRA_PG_*         Postgres command-line settings. max_connections stays above the Prisma pool + the migration step at boot +
#                      the hub backup's pg_dump. wal_compression=on is free CPU-wise on a 1 vCPU box and halves WAL volume.
#   TUGRA_REDIS_MAXMEMORY  Redis maxmemory with the noeviction policy: BullMQ (queues, repeat jobs) and the refresh-token store need
#                      noeviction, so a full Redis answers writes with an error (loud) instead of silently dropping a job. Persistence
#                      (RDB defaults) is deliberately left alone: turning it off would drop every session on a restart.
#   HUB_DB_CONNECTION_LIMIT / HUB_DB_POOL_TIMEOUT  the hub's own Prisma pool (appended to its DATABASE_URL in the process, see
#                      apps/hub-api/src/prisma/database-url.ts; an existing connection_limit/pool_timeout in the URL always wins).
#   HUB_MEM_LIMIT / WEB_MEM_LIMIT / REDIS_MEM_LIMIT  container memory ceilings, only on tiny and small hosts and only on services
#                      that are heap-capped AND restart cleanly: the ceiling is the cap plus the measured native overhead, so it
#                      never trips before the cap does; its job is to keep a runaway inside its own container instead of letting the
#                      host's OOM killer pick Postgres. Postgres, the agent and the updater get NO ceiling (killing Postgres mid-write
#                      costs a crash recovery; the updater's pulls and the agent's child processes spike legitimately). No memswap
#                      limit anywhere: a swap-less ceiling would turn a short spike into a kill, the swapfile lib/swap.sh adds is the cushion.
#                      "0" = unlimited (what compose gets when the key is absent).

PROFILE_FS="${TUGRA_FS_ROOT:-}"
PROFILE_TINY_KB="${TUGRA_PROFILE_TINY_KB:-1572864}"   # 1.5 GiB
PROFILE_SMALL_KB="${TUGRA_PROFILE_SMALL_KB:-3145728}" # 3 GiB
PROFILE_NAMES="tiny small standard"

# Every key a profile manages, in the order they are written to .env.
PROFILE_KEYS="HUB_MAX_HEAP_MB HUB_SEMI_SPACE_MB HUB_MALLOC_ARENA_MAX WEB_MAX_HEAP_MB TUGRA_PG_SHARED_BUFFERS TUGRA_PG_EFFECTIVE_CACHE_SIZE TUGRA_PG_WORK_MEM TUGRA_PG_MAINTENANCE_WORK_MEM TUGRA_PG_MAX_CONNECTIONS TUGRA_PG_PARALLEL_WORKERS TUGRA_PG_MAX_WAL_SIZE TUGRA_PG_CHECKPOINT_TIMEOUT TUGRA_REDIS_MAXMEMORY HUB_DB_CONNECTION_LIMIT HUB_DB_POOL_TIMEOUT HUB_MEM_LIMIT WEB_MEM_LIMIT REDIS_MEM_LIMIT"

profile_ram_kb() { awk '/^MemTotal:/ {print $2; exit}' "$PROFILE_FS/proc/meminfo" 2>/dev/null || true; }

profile_valid() {
  case "$1" in tiny|small|standard) return 0 ;; *) return 1 ;; esac
}

# The profile for this host's RAM. An unreadable RAM size (macOS, a minimal container) is `standard`: never guess small.
profile_detect() {
  local kb; kb="$(profile_ram_kb)"
  case "$kb" in ''|*[!0-9]*) echo standard; return 0 ;; esac
  if [ "$kb" -lt "$PROFILE_TINY_KB" ]; then echo tiny
  elif [ "$kb" -lt "$PROFILE_SMALL_KB" ]; then echo small
  else echo standard; fi
}

# KEY=VALUE lines for a profile. The `standard` numbers are today's behaviour or better; keep them equal to the compose defaults
# (a spec asserts it) so an install without TUGRA_PROFILE and a standard install behave the same.
profile_values() {
  case "$1" in
    tiny)
      cat <<'EOF'
HUB_MAX_HEAP_MB=256
HUB_SEMI_SPACE_MB=2
HUB_MALLOC_ARENA_MAX=2
WEB_MAX_HEAP_MB=96
TUGRA_PG_SHARED_BUFFERS=64MB
TUGRA_PG_EFFECTIVE_CACHE_SIZE=256MB
TUGRA_PG_WORK_MEM=2MB
TUGRA_PG_MAINTENANCE_WORK_MEM=32MB
TUGRA_PG_MAX_CONNECTIONS=30
TUGRA_PG_PARALLEL_WORKERS=0
TUGRA_PG_MAX_WAL_SIZE=512MB
TUGRA_PG_CHECKPOINT_TIMEOUT=10min
TUGRA_REDIS_MAXMEMORY=96mb
HUB_DB_CONNECTION_LIMIT=8
HUB_DB_POOL_TIMEOUT=20
HUB_MEM_LIMIT=640m
WEB_MEM_LIMIT=256m
REDIS_MEM_LIMIT=192m
EOF
      ;;
    small)
      cat <<'EOF'
HUB_MAX_HEAP_MB=384
HUB_SEMI_SPACE_MB=4
HUB_MALLOC_ARENA_MAX=2
WEB_MAX_HEAP_MB=128
TUGRA_PG_SHARED_BUFFERS=128MB
TUGRA_PG_EFFECTIVE_CACHE_SIZE=512MB
TUGRA_PG_WORK_MEM=4MB
TUGRA_PG_MAINTENANCE_WORK_MEM=48MB
TUGRA_PG_MAX_CONNECTIONS=40
TUGRA_PG_PARALLEL_WORKERS=1
TUGRA_PG_MAX_WAL_SIZE=768MB
TUGRA_PG_CHECKPOINT_TIMEOUT=10min
TUGRA_REDIS_MAXMEMORY=128mb
HUB_DB_CONNECTION_LIMIT=10
HUB_DB_POOL_TIMEOUT=20
HUB_MEM_LIMIT=768m
WEB_MEM_LIMIT=320m
REDIS_MEM_LIMIT=256m
EOF
      ;;
    standard)
      cat <<'EOF'
HUB_MAX_HEAP_MB=1024
HUB_SEMI_SPACE_MB=16
HUB_MALLOC_ARENA_MAX=2
WEB_MAX_HEAP_MB=512
TUGRA_PG_SHARED_BUFFERS=256MB
TUGRA_PG_EFFECTIVE_CACHE_SIZE=1GB
TUGRA_PG_WORK_MEM=4MB
TUGRA_PG_MAINTENANCE_WORK_MEM=64MB
TUGRA_PG_MAX_CONNECTIONS=60
TUGRA_PG_PARALLEL_WORKERS=2
TUGRA_PG_MAX_WAL_SIZE=1GB
TUGRA_PG_CHECKPOINT_TIMEOUT=5min
TUGRA_REDIS_MAXMEMORY=256mb
HUB_DB_CONNECTION_LIMIT=16
HUB_DB_POOL_TIMEOUT=20
HUB_MEM_LIMIT=0
WEB_MEM_LIMIT=0
REDIS_MEM_LIMIT=0
EOF
      ;;
    *) return 1 ;;
  esac
}

# The stored profile name, quotes/whitespace stripped; empty when none (or an unknown one: treated as none, never fatal).
profile_stored() {
  local v; v="$(env_get TUGRA_PROFILE | tr -d "\"' \r")"
  profile_valid "$v" && echo "$v" || true
}

# Write the profile into .env. mode "force" (an explicit --profile): overwrite every managed key. mode "fill" (first detection):
# only keys that are not there yet, so an operator's own HUB_MAX_HEAP_MB (or one an earlier installer wrote) survives.
profile_apply() {
  local name="$1" mode="${2:-fill}" line k v
  profile_valid "$name" || return 1
  set_env TUGRA_PROFILE "$name" || return 1
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    if [ "$mode" = "force" ]; then set_env "$k" "$v" || return 1; else ensure_env "$k" "$v" || return 1; fi
  done < <(profile_values "$name")
}

# One human line per profile choice, used by the installer and --doctor.
profile_describe() {
  local kb; kb="$(profile_ram_kb)"
  case "$kb" in ''|*[!0-9]*) printf 'RAM unknown' ;; *) printf '~%s MB RAM' "$(( (kb + 512) / 1024 ))" ;; esac
}

# Pick + persist the profile for this run. $1 = the --profile value ("" = none given, "auto" = detect again).
profile_select() {
  local want="$1" stored detected name
  stored="$(profile_stored)"; detected="$(profile_detect)"
  if [ -n "$want" ] && [ "$want" != "auto" ]; then
    profile_valid "$want" || { err "--profile must be one of: tiny, small, standard, auto (got: $want)"; return 1; }
    profile_apply "$want" force || return 1
    ok "Profile: $want (chosen with --profile; $(profile_describe))"
  elif [ "$want" = "auto" ]; then
    profile_apply "$detected" force || return 1
    ok "Profile: $detected (detected from $(profile_describe))"
  elif [ -n "$stored" ]; then
    name="$stored"
    ok "Profile: $name (kept from .env)"
    if [ "$detected" != "$stored" ]; then
      note "This host's RAM ($(profile_describe)) suggests the '$detected' profile; re-run with --profile=$detected (or --profile=auto) to switch."
    fi
  else
    profile_apply "$detected" fill || return 1
    ok "Profile: $detected (detected from $(profile_describe); change with --profile=<tiny|small|standard>)"
  fi
}

# Read-only, for --doctor. Never a failure: a profile that does not match the RAM is advice.
profile_doctor() {
  local stored detected
  stored="$(profile_stored)"; detected="$(profile_detect)"
  if [ -z "$stored" ]; then
    if [ "$detected" = "standard" ]; then
      ok "Profile: none set (compose defaults = the standard profile; fine for $(profile_describe))"
    else
      note "Profile: none set, but this host has $(profile_describe): the '$detected' profile fits it (smaller heap caps, Postgres and Redis limits). Apply:  ./scripts/install.sh --profile=$detected"
    fi
  elif [ "$stored" = "$detected" ]; then
    ok "Profile: $stored ($(profile_describe))"
  else
    note "Profile: $stored in .env, but $(profile_describe) fits '$detected'. Switch:  ./scripts/install.sh --profile=$detected"
  fi
}
