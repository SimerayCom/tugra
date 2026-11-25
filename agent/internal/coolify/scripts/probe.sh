# Tugra: read-only probe of a server, run over SSH from the Coolify host. It prints TUGRA_PROBE lines and changes nothing.
# Only facts are printed: never an environment value, a key or a file's content. TUGRA_HUB is set by the caller.
tugra_probe_main() {
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  p() { printf 'TUGRA_PROBE %s=%s\n' "$1" "$2"; }
  p uid "$(id -u 2>/dev/null)"
  p arch "$(uname -m 2>/dev/null)"
  dp=no; da=no; sd=no
  if command -v docker >/dev/null 2>&1; then
    dp=yes
    if docker info >/dev/null 2>&1; then da=yes; fi
  fi
  p docker_present "$dp"
  p docker_access "$da"
  sv=no
  if command -v sudo >/dev/null 2>&1; then
    so="$(sudo -n true 2>&1)" && sv=yes
    if [ "$sv" != "yes" ]; then
      case "$so" in *tty*|*terminal*) sv=tty ;; esac
    fi
  else
    sv=none
  fi
  p sudo "$sv"
  D=""
  if [ "$da" = "yes" ]; then
    D="docker"
  elif [ "$dp" = "yes" ] && [ "$sv" = "yes" ]; then
    if sudo -n docker info >/dev/null 2>&1; then sd=yes; D="sudo -n docker"; fi
  fi
  p sudo_docker "$sd"
  ag=unknown
  if [ -n "$D" ]; then
    if ! $D inspect tugra-agent >/dev/null 2>&1; then
      ag=none
    elif $D inspect -f '{{range .Config.Env}}{{println .}}{{end}}' tugra-agent 2>/dev/null | grep -Fxq "TUGRA_HUB=${TUGRA_HUB:-}"; then
      if [ "$($D inspect -f '{{.State.Running}}' tugra-agent 2>/dev/null)" = "true" ]; then ag=ours; else ag=stopped; fi
    else
      ag=foreign_hub
    fi
    p engine "$($D info --format '{{.ID}}' 2>/dev/null | head -c 80)"
  elif [ "$dp" = "no" ]; then
    ag=none
  fi
  p agent "$ag"
  dd="$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')"
  [ -n "$dd" ] || dd="$(df -Pm / 2>/dev/null | awk 'NR==2{print $4}')"
  p disk_mb "$dd"
  hr=unknown
  hh="${TUGRA_HUB:-}"
  hh="${hh#*://}"; hh="${hh%%/*}"
  case "${TUGRA_HUB:-}" in wss://*) hs=https ;; ws://*) hs=http ;; *) hs="" ;; esac
  if [ -n "$hs" ] && [ -n "$hh" ]; then
    if command -v curl >/dev/null 2>&1; then
      if curl -sk -m 8 -o /dev/null "$hs://$hh/" 2>/dev/null; then hr=yes; else hr=no; fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q -T 8 --no-check-certificate --spider "$hs://$hh/" >/dev/null 2>&1; then hr=yes; else hr=unknown; fi
    fi
  fi
  p hub "$hr"
  if [ -r /etc/machine-id ]; then
    mid="$(tr -d ' \n' < /etc/machine-id 2>/dev/null)"
    if [ -n "$mid" ] && command -v sha256sum >/dev/null 2>&1; then
      p mid "$(printf '%s%s' tugra-mid-v1 "$mid" | sha256sum | cut -c1-64)"
    fi
  fi
  p end 1
}
tugra_probe_main </dev/null
