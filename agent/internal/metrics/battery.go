package metrics

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// powerSupplyRoot is the sysfs power-supply dir; a package var so tests can point it at a fake tree.
var powerSupplyRoot = "/sys/class/power_supply"

// readSysFile returns a trimmed sysfs file value, or "" when it cannot be read. Shared by the battery
// and AMD-GPU sysfs readers.
func readSysFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// readBattery returns the system battery (laptop / UPS hosts) or nil on servers and VMs with none. It
// takes the first power-supply whose `type` is "Battery", skipping peripheral batteries (scope ==
// "Device", e.g. a wireless mouse). Pure sysfs reads — gopsutil has no battery API.
func readBattery() *protocol.Battery {
	entries, err := os.ReadDir(powerSupplyRoot)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		dir := filepath.Join(powerSupplyRoot, e.Name())
		if !strings.EqualFold(readSysFile(filepath.Join(dir, "type")), "Battery") {
			continue
		}
		if strings.EqualFold(readSysFile(filepath.Join(dir, "scope")), "Device") {
			continue
		}
		raw := readSysFile(filepath.Join(dir, "capacity"))
		if raw == "" {
			continue
		}
		pct, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			continue
		}
		if pct < 0 {
			pct = 0
		} else if pct > 100 {
			pct = 100
		}
		state := readSysFile(filepath.Join(dir, "status"))
		if state == "" {
			state = "Unknown"
		}
		if len(state) > 16 {
			state = state[:16]
		}
		return &protocol.Battery{Percent: pct, State: state}
	}
	return nil
}
