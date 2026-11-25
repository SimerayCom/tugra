# Tugra: remove the agent that THIS run installed, over SSH from the Coolify host. TUGRA_CID is the container id the install reported and
# TUGRA_HUB the hub that agent belongs to; if either does not match the container named tugra-agent right now, nothing is touched.
tugra_uninstall_main() {
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  r() { printf 'TUGRA_UNINSTALL %s\n' "$1"; }
  cid="${TUGRA_CID:-}"
  case "$cid" in
    *[!0-9a-f]*|"") r refused_id; return 0 ;;
  esac
  [ "${#cid}" -eq 64 ] || { r refused_id; return 0; }
  command -v docker >/dev/null 2>&1 || { r refused_docker; return 0; }
  cur="$(docker inspect -f '{{.Id}}' tugra-agent 2>/dev/null)" || { r gone; return 0; }
  [ "$cur" = "$cid" ] || { r refused_id; return 0; }
  if ! docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" 2>/dev/null | grep -Fxq "TUGRA_HUB=${TUGRA_HUB:-}"; then
    r refused_hub; return 0
  fi
  docker stop -t 20 "$cid" >/dev/null 2>&1 || true
  docker rm "$cid" >/dev/null 2>&1 || { r failed; return 0; }
  docker volume rm tugra-agent-data >/dev/null 2>&1 || true
  rm -f /etc/tugra/host-facts.json 2>/dev/null || true
  r ok
}
tugra_uninstall_main </dev/null
