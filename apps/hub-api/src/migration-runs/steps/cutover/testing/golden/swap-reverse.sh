set -u
ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
docker stop tugra-proxy >/dev/null 2>&1 || true
docker update --restart=unless-stopped "$ID" >/dev/null 2>&1 || echo "TUGRA_SWAP_UPDATE_FAILED"
docker start "$ID" >/dev/null 2>&1 || true
echo "TUGRA_SWAP_SOURCE_RUNNING=$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"
echo "TUGRA_SWAP_TARGET=$(docker container inspect -f '{{.State.Status}}' tugra-proxy 2>/dev/null || echo absent)"
