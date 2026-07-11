// Package metrics collects host metrics via gopsutil.
package metrics

import (
	"regexp"
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

// physicalDiskRe matches WHOLE physical disks (sda, vda, nvme0n1, mmcblk0) but not partitions
// (sda1, nvme0n1p1) or virtual devices (loop*, dm-*, sr*, md*, ram*). Summing partitions and their
// parent disk — or an LVM/loop layer over a physical disk — would double-count every byte.
var physicalDiskRe = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$`)

func isPhysicalDisk(name string) bool { return physicalDiskRe.MatchString(name) }

// ioRate turns a pair of cumulative byte counters into per-second rates. It guards a zero/negative
// interval and counter resets (device flap, reboot, wraparound): a channel whose counter went
// backwards yields 0 rather than a bogus negative or huge spike, guarded independently. Shared by
// the network and disk-I/O paths (both are cumulative → rate).
func ioRate(prevA, prevB, curA, curB uint64, elapsed float64) (a, b float64) {
	if elapsed <= 0 {
		return 0, 0
	}
	if curA >= prevA {
		a = float64(curA-prevA) / elapsed
	}
	if curB >= prevB {
		b = float64(curB-prevB) / elapsed
	}
	return a, b
}

// Collector wraps Collect with the state needed to derive network + disk-I/O rates from successive
// samples. It is not safe for concurrent use; call Sample from a single goroutine (the agent's
// metrics ticker loop).
type Collector struct {
	// Each source keeps its OWN baseline timestamp so `elapsed` always spans exactly the interval
	// its counter accumulated over. A transient IOCounters failure on one source freezes only that
	// source's baseline+time (its next success divides by the true multi-interval span, not a single
	// tick — no spike), and never disturbs the other source.
	prevRx, prevTx uint64
	prevTimeNet    time.Time
	hasPrevNet     bool

	prevDiskRead, prevDiskWrite uint64
	prevTimeDisk                time.Time
	hasPrevDisk                 bool
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
		if c.hasPrevNet {
			s.NetRx, s.NetTx = ioRate(c.prevRx, c.prevTx, rx, tx, now.Sub(c.prevTimeNet).Seconds())
		}
		// Advance baseline + time ATOMICALLY: elapsed must always match the counter span.
		c.prevRx, c.prevTx, c.prevTimeNet, c.hasPrevNet = rx, tx, now, true
	}
	// Disk I/O throughput: sum ReadBytes/WriteBytes over whole physical disks only (partitions and
	// LVM/loop layers would double-count). First sample has no baseline → rate stays 0.
	if io, e := disk.IOCounters(); e == nil {
		var read, write uint64
		for name, st := range io {
			if !isPhysicalDisk(name) {
				continue
			}
			read += st.ReadBytes
			write += st.WriteBytes
		}
		if c.hasPrevDisk {
			s.DiskRead, s.DiskWrite = ioRate(c.prevDiskRead, c.prevDiskWrite, read, write, now.Sub(c.prevTimeDisk).Seconds())
		}
		c.prevDiskRead, c.prevDiskWrite, c.prevTimeDisk, c.hasPrevDisk = read, write, now, true
	}
	return s, nil
}
