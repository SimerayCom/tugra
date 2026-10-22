package metrics

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const maxGPUs = 8

// drmRoot is the sysfs DRM dir (AMD GPUs); a package var so tests can point it at a fake tree.
var drmRoot = "/sys/class/drm"

// collectGPU returns live GPU stats from NVIDIA (nvidia-smi, if present) then AMD (sysfs). nil when no
// GPU is found. Runs OFF the heartbeat hot path (via the Collector's background cache), so the
// nvidia-smi fork + 2s timeout can never stall the agent.
func collectGPU() []protocol.GPUStat {
	out := collectNvidia()
	out = append(out, collectAMD()...)
	if len(out) == 0 {
		return nil
	}
	if len(out) > maxGPUs {
		out = out[:maxGPUs]
	}
	return out
}

func collectNvidia() []protocol.GPUStat {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return nil // no NVIDIA runtime / toolkit in this container
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
		"--format=csv,noheader,nounits")
	b, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseNvidiaCSV(string(b))
}

// parseNvidiaCSV parses `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,
// temperature.gpu,power.draw --format=csv,noheader,nounits` output. Memory is MiB -> bytes; "[N/A]" or
// unparseable fields become 0. Pure/testable.
func parseNvidiaCSV(s string) []protocol.GPUStat {
	var out []protocol.GPUStat
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		f := strings.Split(line, ",")
		if len(f) < 6 {
			continue
		}
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		out = append(out, protocol.GPUStat{
			Name:     clip(f[0], 64),
			Util:     clampPct(num(f[1])),
			MemUsed:  num(f[2]) * 1024 * 1024,
			MemTotal: num(f[3]) * 1024 * 1024,
			Temp:     num(f[4]),
			Power:    num(f[5]),
		})
		if len(out) >= maxGPUs {
			break
		}
	}
	return out
}

// collectAMD reads AMD GPUs from /sys/class/drm/card*/device (amdgpu driver). No tool or privilege.
func collectAMD() []protocol.GPUStat {
	cards, err := filepath.Glob(filepath.Join(drmRoot, "card*/device"))
	if err != nil {
		return nil
	}
	var out []protocol.GPUStat
	for _, dev := range cards {
		busy := readSysFile(filepath.Join(dev, "gpu_busy_percent"))
		if busy == "" {
			continue // not an amdgpu card
		}
		g := protocol.GPUStat{
			Name:     clip(firstNonEmpty(readSysFile(filepath.Join(dev, "product_name")), "AMD GPU"), 64),
			Util:     clampPct(num(busy)),
			MemUsed:  num(readSysFile(filepath.Join(dev, "mem_info_vram_used"))),
			MemTotal: num(readSysFile(filepath.Join(dev, "mem_info_vram_total"))),
		}
		if hw, _ := filepath.Glob(filepath.Join(dev, "hwmon/hwmon*/temp1_input")); len(hw) > 0 {
			g.Temp = num(readSysFile(hw[0])) / 1000
		}
		out = append(out, g)
		if len(out) >= maxGPUs {
			break
		}
	}
	return out
}

func num(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return v
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func clip(s string, n int) string {
	s = strings.ToValidUTF8(strings.TrimSpace(s), "")
	if len(s) > n {
		return s[:n]
	}
	return s
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
