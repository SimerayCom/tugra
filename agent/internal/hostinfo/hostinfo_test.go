package hostinfo

import (
	"net"
	"testing"
)

func TestCollect(t *testing.T) {
	info, err := Collect()
	if err != nil {
		t.Fatalf("Collect() error: %v", err)
	}
	if info.Arch == "" {
		t.Error("expected non-empty arch")
	}
	if info.CPUCores <= 0 {
		t.Errorf("expected cpuCores > 0, got %d", info.CPUCores)
	}
	if info.MemTotalBytes == 0 {
		t.Error("expected memTotalBytes > 0")
	}
	if info.BootTime <= 0 {
		t.Error("expected a positive bootTime")
	}
	// ReportedIps may be empty on a CI box with only loopback/virtual NICs, but it
	// must never contain a loopback address (the reachability invariant).
	for _, s := range info.ReportedIps {
		if ip := net.ParseIP(s); ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			t.Errorf("reported IP %q should not be loopback/link-local/unparseable", s)
		}
	}
}

func TestKeepIP(t *testing.T) {
	cases := []struct {
		name string
		ip   string
		want bool
	}{
		{"eth0", "203.0.113.7", true},
		{"eth0", "10.0.0.5", true},
		{"ens3", "2001:db8::1", true},
		{"lo", "127.0.0.1", false},     // loopback
		{"eth0", "127.0.0.1", false},   // loopback regardless of iface
		{"eth0", "169.254.1.1", false}, // link-local
		{"veth1a2b", "10.0.0.9", false},
		{"docker0", "172.17.0.1", false},
		{"br-abc123", "10.1.0.1", false},
	}
	for _, c := range cases {
		if got := keepIP(c.name, net.ParseIP(c.ip)); got != c.want {
			t.Errorf("keepIP(%q, %q) = %v, want %v", c.name, c.ip, got, c.want)
		}
	}
	if keepIP("eth0", nil) {
		t.Error("keepIP with nil IP should be false")
	}
}
