package hostinfo

import "testing"

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
}
