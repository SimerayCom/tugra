set -u
docker ps -a --filter label=coolify.managed=true --format '{{.ID}} {{.Names}} {{.State}}' 2>/dev/null | while read -r id name state; do
  case "$name" in tugra*) continue;; esac
  r=false; [ "$state" = "running" ] && r=true
  printf 'TUGRA_SRC id=%s name=%s running=%s\n' "$id" "$name" "$r"
done
echo "TUGRA_SRC_END"
