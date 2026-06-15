// Package metrics collects host metrics via gopsutil.
package metrics

import (
	"time"

	"github.com/mrcandev/tugra/agent/internal/protocol"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
)

// Collect gathers a single host metrics sample. Network rates are 0 for now
// (delta tracking lands with Docker container stats in a later slice).
func Collect() (protocol.MetricsSample, error) {
	s := protocol.MetricsSample{Ts: time.Now().UnixMilli()}

	if pct, err := cpu.Percent(0, false); err == nil && len(pct) > 0 {
		s.CPU = pct[0]
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		s.MemUsed = float64(vm.Used)
		s.MemTotal = float64(vm.Total)
	}
	if du, err := disk.Usage("/"); err == nil {
		s.DiskUsed = float64(du.Used)
		s.DiskTotal = float64(du.Total)
	}
	return s, nil
}
