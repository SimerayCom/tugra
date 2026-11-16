set -u
P='/health'
IP=$(docker container inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' tugra-proxy 2>/dev/null | awk '{print $1}')
case "$IP" in ''|*[!0-9.]*) echo "TUGRA_DARK_PROBE_NOPROXY"; exit 0;; esac
command -v curl >/dev/null 2>&1 || { echo "TUGRA_DARK_PROBE_UNAVAILABLE"; exit 0; }
T=$(mktemp) || exit 0
trap 'rm -f "$T"' EXIT
for H in 'a.example.com' 'b.example.com'; do
  v=$(curl -sS -o /dev/null -m 8 -w '%{ssl_verify_result}' --resolve "$H:443:$IP" "https://$H/" 2>/dev/null)
  code=$(curl -ksS -o "$T" -m 8 -w '%{http_code}' --resolve "$H:443:$IP" "https://$H$P" 2>/dev/null)
  t=0
  [ "$(head -c 18 "$T" 2>/dev/null)" = "404 page not found" ] && t=1
  printf 'TUGRA_DARK_PROBE host=%s verify=%s status=%s traefik404=%s\n' "$H" "${v:-x}" "${code:-000}" "$t"
done
echo "TUGRA_DARK_PROBE_END"
