// Package hostinfo gathers the host's hardware/OS inventory via gopsutil.
package hostinfo

import (
	"context"
	"net"
	"os"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
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
	// The agent runs in a bridge-networked container: overlay the HOST's identity and interfaces (see host.go).
	// 1) the facts the installer captured on the host; 2) fresher runtime readings (Docker daemon, host-network helper).
	if hf, ok := ReadHostFacts(HostFactsPath); ok {
		if hf.Hostname != "" {
			info.Hostname = hf.Hostname
		}
		if hf.OS != "" {
			info.OS, info.OSVersion = hf.OS, hf.OSVersion
		}
		if len(hf.IPs) > 0 {
			info.ReportedIps = hf.IPs
		}
		info.MachineIDHash = CleanMachineIDHash(hf.MachineIDHash)
	}
	ctx := context.Background()
	if h, ok := DockerHostOS(ctx); ok {
		if h.Hostname != "" {
			info.Hostname = h.Hostname
		}
		info.DockerEngineID = h.EngineID
		if h.OS != "" {
			info.OS, info.OSVersion = h.OS, h.OSVersion
		}
	}
	if ips := HostReportedIPs(ctx, os.Getenv("TUGRA_AGENT_IMAGE")); len(ips) > 0 {
		info.ReportedIps = ips
	}
	// Cloud metadata (link-local, never an outbound probe): the instance's public address when the interfaces only
	// carry a private one (AWS, GCP, ...). In-container first; the host-network helper covers the IMDSv2 hop limit.
	cloud := DetectCloudIPs(ctx)
	if cloud.Empty() {
		cloud = HostCloudIPs(ctx, os.Getenv("TUGRA_AGENT_IMAGE"))
	}
	if !cloud.Empty() {
		info.CloudProvider = cloud.Provider
		for _, ip := range []string{cloud.IPv4, cloud.IPv6} {
			if ip != "" {
				info.MetadataIps = append(info.MetadataIps, ip)
			}
		}
	}
	// No metadata answer (or none that names the provider): the hypervisor's DMI vendor string usually does. It only
	// names the provider (used for a price estimate); it never carries an address.
	if info.CloudProvider == "" {
		info.CloudProvider = DMIProvider()
	}
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
