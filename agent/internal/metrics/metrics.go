// Package metrics collects host metrics via gopsutil.
package metrics

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
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
	if sw, err := mem.SwapMemory(); err == nil && sw != nil {
		used, total := float64(sw.Used), float64(sw.Total)
		s.SwapUsed, s.SwapTotal = &used, &total
	}
	if du, err := disk.Usage(diskProbePath()); err == nil {
		s.DiskUsed = float64(du.Used)
		s.DiskTotal = float64(du.Total)
	}
	// Load average is unsupported on some OSes (error) — leave it nil/omitted, never fail the sample.
	if la, err := load.Avg(); err == nil && la != nil {
		l1, l5, l15 := la.Load1, la.Load5, la.Load15
		s.Load1, s.Load5, s.Load15 = &l1, &l5, &l15
	}
	return s, nil
}

// diskProbePath returns the filesystem path whose usage reflects where Docker (and thus app images,
// volumes and build cache) actually consumes space. The agent is always a container with no
// host-rootfs mount, so a plain "/" measures its own overlay upperdir: on the default overlay2
// driver that already sits on the data-root filesystem, but on btrfs/zfs/devicemapper it does not,
// so "/" can under-report the real disk pressure the cleanup targets.
//
// Resolution is cached (resolving per sample would exec `docker info` every tick) and strictly
// fail-soft: any probe that can't be statfs'd is skipped, and the final fallback is the original
// "/", so a sample is never blocked or lost. The protocol is unchanged — diskUsed/diskTotal still
// mean the same thing, just measured on a better-chosen filesystem.
var (
	diskPathOnce sync.Once
	diskPathVal  string
)

func diskProbePath() string {
	diskPathOnce.Do(func() { diskPathVal = resolveDiskPath(dockerRootDir) })
	return diskPathVal
}

// resolveDiskPath walks the probe chain. dockerRoot is injected so tests don't exec docker.
func resolveDiskPath(dockerRoot func() string) string {
	// 1. Explicit operator override — the escape hatch for exotic storage layouts. The env is only what `docker run` set: a
	//    self-update re-creates the container without it, so a usable override is remembered under /etc/tugra (mounted into
	//    the agent, like traffic-ip-mode) and read back when the env is absent.
	if p := strings.TrimSpace(os.Getenv("TUGRA_DISK_PATH")); p != "" {
		if diskUsable(p) {
			persistDiskPath(p)
			return p
		}
	} else if p := readDiskPathFile(); p != "" && diskUsable(p) {
		return p
	}
	// 2. Docker's own data-root, when it happens to be visible inside the agent container.
	if p := strings.TrimSpace(dockerRoot()); p != "" && diskUsable(p) {
		return p
	}
	// 3. The agent's data dir — a named volume mounted at ~/.tugra that lives UNDER the data-root, so
	//    its filesystem IS the data-root's regardless of the storage driver. Reliably present in prod.
	if home, err := os.UserHomeDir(); err == nil {
		if p := filepath.Join(home, ".tugra"); diskUsable(p) {
			return p
		}
	}
	// 4. Original behaviour.
	return "/"
}

// diskPathFile remembers TUGRA_DISK_PATH across self-updates (a var so the tests can point it elsewhere).
var diskPathFile = "/etc/tugra/disk-path"

func readDiskPathFile() string {
	b, err := os.ReadFile(diskPathFile)
	if err != nil || len(b) > 4096 {
		return ""
	}
	p := strings.TrimSpace(string(b))
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\n\r\x00") {
		return ""
	}
	return p
}

// persistDiskPath is best effort and only writes into an existing /etc/tugra (never creates it, never fails a sample).
func persistDiskPath(p string) {
	if readDiskPathFile() == p {
		return
	}
	if st, err := os.Stat(filepath.Dir(diskPathFile)); err != nil || !st.IsDir() {
		return
	}
	_ = os.WriteFile(diskPathFile, []byte(p+"\n"), 0o644)
}

// diskUsable reports whether gopsutil can statfs the path (so it's a real mount we can measure).
func diskUsable(p string) bool { _, err := disk.Usage(p); return err == nil }

// dockerRootDir returns `docker info`'s DockerRootDir, or "" on any error/timeout. Off the hot path
// (called once, cached by diskProbePath); a short timeout keeps a hung daemon from stalling startup.
func dockerRootDir() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "info", "-f", "{{.DockerRootDir}}").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
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

	// The host's cumulative network counters, refreshed off the hot path (see nethost.go) because the agent's own
	// /proc/net/dev is its container's namespace. netCountersAt is when the cached counters were read.
	netMu         sync.Mutex
	netInflight   atomic.Bool
	netAt         time.Time
	netCountersAt time.Time
	netOK         bool
	netRx, netTx  uint64
	// the last computed rate, repeated while no newer host reading has arrived (the heartbeat can be faster than the refresh)
	lastRateRx, lastRateTx float64

	// Slow/optional sensors (temperature + GPU) are refreshed OFF the hot path: gopsutil's sensor read
	// can block and nvidia-smi can hang, while Sample() runs inline right before the heartbeat, so a
	// synchronous call could make the server flap OFFLINE. kickSlow() launches at most one background
	// refresh when the cache is stale; Sample() only copies the cache. Battery is a fast sysfs read,
	// done inline.
	slowMu       sync.Mutex
	slowInflight atomic.Bool
	slowAt       time.Time
	tempCache    *float64
	sensorsCache map[string]float64
	gpuCache     []protocol.GPUStat
}

// kickSlow launches one background refresh of the temperature + GPU caches when the last one is older
// than ~4s and none is already running. It never blocks the caller.
func (c *Collector) kickSlow() {
	c.slowMu.Lock()
	fresh := !c.slowAt.IsZero() && time.Since(c.slowAt) < 4*time.Second
	c.slowMu.Unlock()
	if fresh || !c.slowInflight.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer c.slowInflight.Store(false)
		temp, sensorMap := collectTemp()
		gpus := collectGPU()
		c.slowMu.Lock()
		c.tempCache, c.sensorsCache, c.gpuCache, c.slowAt = temp, sensorMap, gpus, time.Now()
		c.slowMu.Unlock()
	}()
}

// netCounters returns the cumulative rx/tx bytes of the REAL interfaces of the server. In the agent's container that is the
// host's, read through a host-network helper (cached, see nethost.go); a binary running directly on a host reads its own
// namespace. pernic=true so only the real external interfaces are summed: the "all" aggregate would fold in loopback and
// Docker bridge/veth traffic.
func (c *Collector) netCounters(now time.Time) (rx, tx uint64, at time.Time, ok bool) {
	if hostNetEnabled() {
		c.kickNet()
		c.netMu.Lock()
		defer c.netMu.Unlock()
		return c.netRx, c.netTx, c.netCountersAt, c.netOK && !c.netCountersAt.IsZero()
	}
	cs, err := net.IOCounters(true)
	if err != nil {
		return 0, 0, now, false
	}
	for _, nic := range cs {
		if isVirtualNIC(nic.Name) {
			continue
		}
		rx += nic.BytesRecv
		tx += nic.BytesSent
	}
	return rx, tx, now, true
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
	if rx, tx, at, ok := c.netCounters(now); ok {
		// Only a NEW reading advances the baseline (the cache may be re-read within one interval): elapsed always spans
		// exactly the counters' own interval.
		if !c.hasPrevNet || at.After(c.prevTimeNet) {
			if c.hasPrevNet {
				c.lastRateRx, c.lastRateTx = ioRate(c.prevRx, c.prevTx, rx, tx, at.Sub(c.prevTimeNet).Seconds())
			}
			// Advance baseline + time ATOMICALLY: elapsed must always match the counter span.
			c.prevRx, c.prevTx, c.prevTimeNet, c.hasPrevNet = rx, tx, at, true
		}
		s.NetRx, s.NetTx = c.lastRateRx, c.lastRateTx
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
	// Optional sensors: temperature + GPU come from the background cache (never blocks the heartbeat);
	// battery is a fast inline sysfs read. Absent hardware leaves the fields nil → omitted on the wire.
	c.kickSlow()
	c.slowMu.Lock()
	s.Temp = c.tempCache
	if len(c.sensorsCache) > 0 {
		s.Sensors = c.sensorsCache
	}
	if len(c.gpuCache) > 0 {
		s.Gpus = c.gpuCache
	}
	c.slowMu.Unlock()
	s.Battery = readBattery()
	return s, nil
}
