#!/usr/bin/env bash
# Swap safety net for small hosts. Sourced by install.sh (needs its ok/note/warn helpers).
#
# Why: the hub (Node + the database client's query engine) keeps a few hundred MB resident and can spike while the
# panel is busy. On a <= 4 GiB host with NO swap the kernel's only answer to a spike is the OOM killer, which takes the
# hub down ("Killed", container restart) instead of slowing it for a moment. A modest swapfile turns that into a
# slow second, not an outage. Applies only to a host with <= 4 GiB RAM and no active swap; a host that already has
# swap (a partition, zram, an earlier swapfile) is never touched.
#
#   swap_ensure   create + enable a 2 GiB /swapfile, idempotently (fallocate, else dd; chmod 600; mkswap; swapon;
#                 /etc/fstab entry; vm.swappiness=10). Never fatal: any failure leaves the host as it was and the
#                 install continues. Off with --no-swap (remembered as TUGRA_NO_SWAP=1 in .env) or TUGRA_NO_SWAP=1.
#   swap_doctor   read-only status line for `install.sh --doctor`.
#
# Test seams (never needed in production): TUGRA_FS_ROOT prefixes /proc, /etc and the swapfile; the commands are looked
# up on PATH so a spec can put stubs first.

SWAP_FS="${TUGRA_FS_ROOT:-}"
SWAP_FILE="${TUGRA_SWAPFILE:-/swapfile}"          # logical path (what goes into fstab)
SWAP_SIZE_MB="${TUGRA_SWAP_SIZE_MB:-2048}"
SWAP_MAX_RAM_KB="${TUGRA_SWAP_MAX_RAM_KB:-4194304}" # 4 GiB; a "4 GB" VM reports slightly less in MemTotal
SWAP_SWAPPINESS="${TUGRA_SWAPPINESS:-10}"

swap_ram_kb() { awk '/^MemTotal:/ {print $2; exit}' "$SWAP_FS/proc/meminfo" 2>/dev/null || true; }
# Number of active swap areas (/proc/swaps has one header line).
swap_active_count() { awk 'NR>1 {n++} END {print n+0}' "$SWAP_FS/proc/swaps" 2>/dev/null || echo 0; }
swap_active_mb() { awk 'NR>1 {s+=$3} END {print int((s+512)/1024)}' "$SWAP_FS/proc/swaps" 2>/dev/null || echo 0; }
swap_is_linux() { [ -n "$SWAP_FS" ] || [ "$(uname -s 2>/dev/null)" = "Linux" ]; }
swap_free_mb() { { df -Pm "$(dirname "$SWAP_FS$SWAP_FILE")" 2>/dev/null || true; } | awk 'NR==2 {print $4}'; }

# Is this host one the swapfile is for? Sets SWAP_WHY when not.
swap_needed() {
  SWAP_WHY=""
  swap_is_linux || { SWAP_WHY="not Linux"; return 1; }
  local kb; kb="$(swap_ram_kb)"
  case "$kb" in ''|*[!0-9]*) SWAP_WHY="RAM size unknown"; return 1 ;; esac
  [ "$kb" -le "$SWAP_MAX_RAM_KB" ] || { SWAP_WHY="$(( (kb + 524288) / 1048576 ))GB RAM is plenty"; return 1; }
  [ "$(swap_active_count)" -eq 0 ] || { SWAP_WHY="swap already active ($(swap_active_mb)MB)"; return 1; }
  return 0
}

swap_fstab_has() { [ -f "$SWAP_FS/etc/fstab" ] && awk -v f="$SWAP_FILE" '$1 == f && $3 == "swap" {found=1} END {exit !found}' "$SWAP_FS/etc/fstab"; }

swap_persist() {
  if ! swap_fstab_has; then
    printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> "$SWAP_FS/etc/fstab" 2>/dev/null || note "Could not add the swapfile to /etc/fstab: it will not come back after a reboot."
  fi
  mkdir -p "$SWAP_FS/etc/sysctl.d" 2>/dev/null || true
  printf '# Written by the Tugra installer: prefer RAM, use swap only under pressure.\nvm.swappiness=%s\n' "$SWAP_SWAPPINESS" > "$SWAP_FS/etc/sysctl.d/99-tugra-swap.conf" 2>/dev/null || true
  if [ -z "$SWAP_FS" ]; then sysctl -q -w "vm.swappiness=$SWAP_SWAPPINESS" >/dev/null 2>&1 || sysctl -q -w vm.swappiness="$SWAP_SWAPPINESS" >/dev/null 2>&1 || true; fi
}

swap_ensure() {
  if [ "${NO_SWAP:-0}" = "1" ]; then note "Swap: skipped (--no-swap). Without swap a <= 4GB host can lose the hub to the kernel's OOM killer under load."; return 0; fi
  swap_needed || return 0
  local file="$SWAP_FS$SWAP_FILE" kb; kb="$(swap_ram_kb)"
  if [ "$(id -u 2>/dev/null || echo 1)" != "0" ]; then
    note "Swap: this host has ~$(( (kb + 524288) / 1048576 ))GB RAM and no swap; re-run as root to add a ${SWAP_SIZE_MB}MB swapfile (or pass --no-swap)."
    return 0
  fi
  if [ -e "$file" ]; then
    # A file is already there (an earlier run, or the operator's own): enable it, never overwrite or resize it.
    if swapon "$file" >/dev/null 2>&1; then
      swap_persist; ok "Swap: enabled the existing $SWAP_FILE"
    else
      note "Swap: $SWAP_FILE exists but is not usable as swap; left untouched. Remove it and re-run, or pass --no-swap."
    fi
    return 0
  fi
  local free; free="$(swap_free_mb)"
  case "$free" in ''|*[!0-9]*) free=0 ;; esac
  if [ "$free" -lt $(( SWAP_SIZE_MB + 2048 )) ]; then
    note "Swap: not enough free disk for a ${SWAP_SIZE_MB}MB swapfile (${free}MB free, needs the size plus 2GB headroom); skipped."
    return 0
  fi
  log "Adding a ${SWAP_SIZE_MB}MB swapfile (this host has ~$(( (kb + 524288) / 1048576 ))GB RAM and no swap)"
  if ! { (umask 077; fallocate -l "${SWAP_SIZE_MB}M" "$file") >/dev/null 2>&1 && chmod 600 "$file" && mkswap "$file" >/dev/null 2>&1 && swapon "$file" >/dev/null 2>&1; }; then
    # fallocate is unsupported on some filesystems (and swapon refuses a sparse/unsupported file): write real blocks.
    swapoff "$file" >/dev/null 2>&1 || true
    rm -f "$file"
    if ! { (umask 077; dd if=/dev/zero of="$file" bs=1M count="$SWAP_SIZE_MB" status=none) >/dev/null 2>&1 && chmod 600 "$file" && mkswap "$file" >/dev/null 2>&1 && swapon "$file" >/dev/null 2>&1; }; then
      rm -f "$file"
      note "Swap: could not enable a swapfile here (a container, or a filesystem that cannot hold swap); skipped. Pass --no-swap to silence this."
      return 0
    fi
  fi
  swap_persist
  ok "Swap: ${SWAP_SIZE_MB}MB swapfile at $SWAP_FILE enabled (vm.swappiness=$SWAP_SWAPPINESS, persisted in /etc/fstab). Opt out with --no-swap."
}

# Read-only, for --doctor. A finding (note), never a failure: a swapless small host works until it is under pressure.
swap_doctor() {
  swap_is_linux || return 0
  local kb n; kb="$(swap_ram_kb)"; n="$(swap_active_count)"
  case "$kb" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$n" -gt 0 ]; then
    ok "Swap: $(swap_active_mb)MB active"
  elif [ "$kb" -le "$SWAP_MAX_RAM_KB" ]; then
    note "Swap: none, with only ~$(( (kb + 524288) / 1048576 ))GB RAM: a load spike can get the hub killed by the OOM killer. Fix:  $(nc_sudo 2>/dev/null)./scripts/install.sh  (adds a ${SWAP_SIZE_MB}MB swapfile; --no-swap opts out)"
  else
    ok "Swap: none (fine with ~$(( (kb + 524288) / 1048576 ))GB RAM)"
  fi
}
