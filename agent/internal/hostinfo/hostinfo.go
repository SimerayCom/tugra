// Package hostinfo gathers the host's hardware/OS inventory via gopsutil.
package hostinfo

import (
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
	return info, nil
}
