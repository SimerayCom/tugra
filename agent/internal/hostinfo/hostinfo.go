// Package hostinfo gathers the host's hardware/OS inventory via gopsutil.
package hostinfo

import (
	"net"
	"strings"

	"github.com/mrcandev/tugra/agent/internal/protocol"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

// Collect gathers a single host inventory snapshot. Best-effort: any field that
// can't be read is left at its zero value rather than failing the whole call.
func Collect() (protocol.HostInfo, error) {
	info := protocol.HostInfo{}

	if h, err := host.Info(); err == nil {
		info.OS = h.Platform
		info.OSVersion = h.PlatformVersion
		info.Kernel = h.KernelVersion
		info.Arch = h.KernelArch
		info.BootTime = int64(h.BootTime)
	}
	if n, err := cpu.Counts(true); err == nil {
		info.CPUCores = n
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		info.MemTotalBytes = vm.Total
	}
	info.ReportedIps = reportedIps()
	return info, nil
}

// isVirtualIface reports whether an interface is a virtual/bridge device whose
// addresses aren't the host's real network identity (loopback is filtered
// separately via IsLoopback). Mirrors the metrics package's NIC filter.
func isVirtualIface(name string) bool {
	return strings.HasPrefix(name, "veth") ||
		strings.HasPrefix(name, "docker") ||
		strings.HasPrefix(name, "br-") ||
		strings.HasPrefix(name, "virbr")
}

// keepIP reports whether an interface address is a real, routable host IP worth
// reporting as a reachability candidate — excludes loopback, link-local, and
// virtual/bridge interfaces. Pure (testable with synthetic inputs).
func keepIP(ifaceName string, ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return !isVirtualIface(ifaceName)
}

// reportedIps enumerates the host's up, non-virtual interface addresses (the
// candidates the hub reconciles against the observed egress IP).
func reportedIps() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if keepIP(iface.Name, ip) {
				out = append(out, ip.String())
			}
		}
	}
	return out
}
