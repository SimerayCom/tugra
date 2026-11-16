set -u
ID=$(docker container inspect -f '{{.Id}}' coolify-proxy 2>/dev/null)
if [ -z "$ID" ]; then echo "TUGRA_SWAP_ABSENT"; exit 0; fi
echo "TUGRA_SWAP_ID=$ID"
echo "TUGRA_SWAP_NAME=$(docker container inspect -f '{{.Name}}' "$ID" 2>/dev/null)"
echo "TUGRA_SWAP_IMAGE=$(docker container inspect -f '{{.Config.Image}}' "$ID" 2>/dev/null)"
echo "TUGRA_SWAP_RESTART=$(docker container inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$ID" 2>/dev/null)"
echo "TUGRA_SWAP_RUNNING=$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null)"
echo "TUGRA_SWAP_PORTS=$(docker container inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}>{{$p}},{{end}}{{end}}' "$ID" 2>/dev/null)"
echo "TUGRA_SWAP_CONTROL_PLANE=$(docker container inspect -f '{{.Config.Image}}' coolify 2>/dev/null)"
echo "TUGRA_SWAP_END"
