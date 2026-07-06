// Package metrics collects host metrics via gopsutil.
package metrics

import (
	"strings"
	"time"

	"github.com/mrcandev/tugra/agent/internal/protocol"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

// Collect gathers a single host metrics sample. Network rates stay 0 here — they
// need two samples to derive a delta, so use a Collector (below) for real net.
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

// isVirtualNIC reports whether an interface is a virtual/loopback device that
// should be excluded from the host's network rate. Counting loopback would
// double-count every localhost byte (it lands on both lo.Rx and lo.Tx), and on a
// Docker host the bridge/veth pairs carry reverse-proxy↔container and
// container↔container traffic — none of which is real external throughput.
func isVirtualNIC(name string) bool {
	return strings.HasPrefix(name, "lo") || // loopback (lo, lo0)
		strings.HasPrefix(name, "veth") || // container veth pairs
		strings.HasPrefix(name, "docker") || // docker0, docker_gwbridge
		strings.HasPrefix(name, "br-") || // docker user-defined bridges
		strings.HasPrefix(name, "virbr") // libvirt/KVM bridges
}

// netRate turns cumulative byte counters into a per-second rate. It guards
// against a zero/negative interval and counter resets (interface flap, reboot,
// counter wraparound): a channel whose counter went backwards yields 0 rather
// than a bogus negative or huge spike, and each channel is guarded independently.
func netRate(prevRx, prevTx, curRx, curTx uint64, elapsed float64) (rx, tx float64) {
	if elapsed <= 0 {
		return 0, 0
	}
	if curRx >= prevRx {
		rx = float64(curRx-prevRx) / elapsed
	}
	if curTx >= prevTx {
		tx = float64(curTx-prevTx) / elapsed
	}
	return rx, tx
}

// Collector wraps Collect with the state needed to derive network rates from
// successive samples. It is not safe for concurrent use; call Sample from a
// single goroutine (the agent's metrics ticker loop).
type Collector struct {
	prevRx, prevTx uint64
	prevTime       time.Time
	hasPrev        bool
}

// NewCollector returns a Collector whose first Sample reports zero network rate.
func NewCollector() *Collector { return &Collector{} }

// Sample collects a host sample and fills NetRx/NetTx with the byte/s rate since
// the previous call. The first sample has no baseline, so its net rate is 0.
func (c *Collector) Sample() (protocol.MetricsSample, error) {
	s, err := Collect()
	if err != nil {
		return s, err
	}
	now := time.Now()
	// pernic=true so we can sum only the real external interfaces — the "all"
	// aggregate would fold in loopback and Docker bridge/veth traffic.
	if cs, e := net.IOCounters(true); e == nil {
		var rx, tx uint64
		for _, nic := range cs {
			if isVirtualNIC(nic.Name) {
				continue
			}
			rx += nic.BytesRecv
			tx += nic.BytesSent
		}
		if c.hasPrev {
			s.NetRx, s.NetTx = netRate(c.prevRx, c.prevTx, rx, tx, now.Sub(c.prevTime).Seconds())
		}
		c.prevRx, c.prevTx, c.prevTime, c.hasPrev = rx, tx, now, true
	}
	return s, nil
}
