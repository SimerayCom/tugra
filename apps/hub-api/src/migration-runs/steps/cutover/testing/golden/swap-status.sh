set -u
ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
echo "TUGRA_SWAP_SOURCE_RUNNING=$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"
echo "TUGRA_SWAP_TARGET=$(docker container inspect -f '{{.State.Status}}' tugra-proxy 2>/dev/null || echo absent)"
echo "TUGRA_SWAP_TARGET_PORTS=$(docker container inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}>{{$p}},{{end}}{{end}}' tugra-proxy 2>/dev/null)"
echo "TUGRA_SWAP_STATUS_END"
