/**
 * GPU detection probe — a PARAMETERLESS, interpolation-free POSIX sh constant run through the existing
 * `sendCommand` channel (capability "bulk"). The agent runs it with bash if present, else sh, inside the
 * agent container: it sees the host's /sys/bus/pci and /proc/driver/nvidia, and has the docker CLI + socket
 * plus $TUGRA_AGENT_IMAGE.
 *
 * Security decisions:
 *  - S1  The script is a pure constant: no hub value, request field or container name is ever spliced in.
 *  - S2  The optional nvidia-smi helper container is fully unprivileged (no --privileged / --pid=host / mounts,
 *        --network none, --read-only, --cap-drop ALL, no-new-privileges, --pids-limit 64, --pull never). The image
 *        comes only from $TUGRA_AGENT_IMAGE (the same trusted source as the patch/fsd helpers).
 *  - S3  Deliberately NOT wrapHostExec: that is --privileged --pid=host, needs the "patch" capability and the
 *        fixed `--name tugra-patch` mutex (patch runs last up to 30 min). The probe has its own fixed name
 *        label `tugra.role=gpu-probe` and a UNIQUE per-run name (`tugra-gpuprobe-<pid>-<epoch>`): a fixed name would be
 *        a mutex that a killed docker CLI (the container keeps running when nvidia-smi hangs) turns into a permanent
 *        "busy". Instead every run first force-removes any leftover container carrying the label, and nvidia-smi runs
 *        under an in-container `timeout`, so the helper exits (and --rm fires) on its own; a failed run is removed too.
 *  - S4  Capability "bulk" (DEFAULT_CAPABILITIES, revocable per server). No new capability.
 *  - S5  All output is untrusted and sanitized hub-side (gpu-inventory.ts) before it is stored or relayed.
 *  - S6  Runtime NAMES only are listed (space-separated): Docker >= 29 adds a multi-KB `status` blob to every runtime
 *        in `{{json .Runtimes}}`, which a byte cap truncated mid-JSON and glued the next line onto. The cap bounds the
 *        names, never the newline.
 */
export const GPU_PROBE_BEGIN = "TUGRA_GPU_PROBE v1";
export const GPU_PROBE_END = "TUGRA_GPU_PROBE_END";

const SCRIPT = `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
echo "TUGRA_GPU_PROBE v1"
for d in /sys/bus/pci/devices/*; do
  [ -r "$d/class" ] || continue
  c=$(cat "$d/class" 2>/dev/null)
  case "$c" in
    0x03*)
      b="\${d##*/}"; v=$(cat "$d/vendor" 2>/dev/null)
      printf 'TUGRA_PCI %s %s %s %s\\n' "$b" "$v" "$(cat "$d/device" 2>/dev/null)" "$c"
      if [ "$v" = "0x10de" ] && [ -r "/proc/driver/nvidia/gpus/$b/information" ]; then
        i="/proc/driver/nvidia/gpus/$b/information"
        m=$(sed -n 's/^Model:[[:space:]]*//p' "$i" | head -n 1 | head -c 120)
        u=$(sed -n 's/^GPU UUID:[[:space:]]*//p' "$i" | head -n 1 | head -c 100)
        printf 'TUGRA_NVPROC %s|%s|%s\\n' "$b" "$u" "$m"
      fi;;
  esac
done
rt=$(docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null) && printf 'TUGRA_RUNTIMES %s\\n' "$(printf %s "$rt" | head -c 2000)"
dr=$(docker info --format '{{.DefaultRuntime}}' 2>/dev/null) && printf 'TUGRA_DEFRT %s\\n' "$dr" | head -c 100
[ -r /proc/driver/nvidia/version ] && printf 'TUGRA_NVRM %s\\n' "$(head -n 1 /proc/driver/nvidia/version)" | head -c 300
if [ -n "$TUGRA_AGENT_IMAGE" ] && printf ' %s ' "$rt" | grep -q ' nvidia '; then
  for o in $(timeout 10 docker ps -aq --filter label=tugra.role=gpu-probe 2>/dev/null); do timeout 10 docker rm -f "$o" >/dev/null 2>&1; done
  pn="tugra-gpuprobe-$$-$(date +%s)"
  out=$(timeout -k 5 30 docker run --rm --pull never --name "$pn" --label tugra.role=gpu-probe \\
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \\
    --gpus all -e NVIDIA_DRIVER_CAPABILITIES=utility \\
    --entrypoint timeout "$TUGRA_AGENT_IMAGE" -k 5 25 nvidia-smi \\
    --query-gpu=index,uuid,name,memory.total,driver_version --format=csv,noheader,nounits 2>&1); rc=$?
  [ $rc -eq 0 ] || timeout 10 docker rm -f "$pn" >/dev/null 2>&1
  if [ $rc -eq 0 ]; then
    printf '%s\\n' "$out" | head -n 20 | sed 's/^/TUGRA_NVSMI /'
  else
    printf 'TUGRA_NVSMI_ERR rc=%s %s\\n' "$rc" "$(printf %s "$out" | tr '\\n' ' ' | head -c 200)"
  fi
fi
echo "TUGRA_GPU_PROBE_END"
exit 0
`;

export function buildGpuProbeScript(): string {
  return SCRIPT;
}
