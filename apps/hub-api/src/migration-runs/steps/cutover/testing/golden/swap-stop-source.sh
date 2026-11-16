set -u
ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
if ! docker update --restart=no "$ID" >/dev/null 2>&1; then echo "TUGRA_SWAP_UPDATE_FAILED"; exit 0; fi
docker stop "$ID" >/dev/null 2>&1 || true
echo "TUGRA_SWAP_SOURCE_RUNNING=$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"
