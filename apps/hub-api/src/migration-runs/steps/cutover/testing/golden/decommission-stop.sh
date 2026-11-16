set -u
for ID in 'abcdef012345' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; do
  docker stop "$ID" >/dev/null 2>&1 || true
  printf 'TUGRA_SRC_STATE id=%s running=%s\n' "$ID" "$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"
done
echo "TUGRA_SRC_STATE_END"
