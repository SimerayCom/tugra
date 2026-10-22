package metrics

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestParseNvidiaCSV(t *testing.T) {
	out := parseNvidiaCSV("NVIDIA GeForce RTX 3060, 42, 2048, 12288, 55, 120.5\nNVIDIA A100, [N/A], 0, 40960, 61, 250\n")
	if len(out) != 2 {
		t.Fatalf("want 2 GPUs, got %d", len(out))
	}
	if out[0].Name != "NVIDIA GeForce RTX 3060" || out[0].Util != 42 || out[0].MemUsed != 2048*1024*1024 || out[0].MemTotal != 12288*1024*1024 || out[0].Temp != 55 || out[0].Power != 120.5 {
		t.Fatalf("gpu0 wrong: %+v", out[0])
	}
	if out[1].Util != 0 { // "[N/A]" -> 0, not a parse failure
		t.Fatalf("want [N/A] util 0, got %v", out[1].Util)
	}
}

func TestParseNvidiaCSVEmptyAndShort(t *testing.T) {
	if out := parseNvidiaCSV(""); out != nil {
		t.Fatalf("empty output -> nil, got %v", out)
	}
	if out := parseNvidiaCSV("only, three, fields\n"); out != nil {
		t.Fatalf("too-short line skipped -> nil, got %v", out)
	}
}

func TestParseNvidiaCSVCapsAtMax(t *testing.T) {
	s := strings.Repeat("g, 1, 1, 1, 1, 1\n", 12)
	if out := parseNvidiaCSV(s); len(out) != maxGPUs {
		t.Fatalf("want cap %d, got %d", maxGPUs, len(out))
	}
}

func TestCollectAMDFromSysfs(t *testing.T) {
	root := t.TempDir()
	drmRoot = root
	t.Cleanup(func() { drmRoot = "/sys/class/drm" })
	dev := filepath.Join(root, "card0", "device")
	writeFile(t, filepath.Join(dev, "gpu_busy_percent"), "37\n")
	writeFile(t, filepath.Join(dev, "mem_info_vram_used"), "1073741824\n")
	writeFile(t, filepath.Join(dev, "mem_info_vram_total"), "8589934592\n")
	writeFile(t, filepath.Join(dev, "product_name"), "AMD Radeon RX 6800\n")
	writeFile(t, filepath.Join(dev, "hwmon", "hwmon3", "temp1_input"), "52000\n")
	writeFile(t, filepath.Join(root, "card1", "device", "vendor"), "0x8086\n") // non-amdgpu, skipped

	out := collectAMD()
	if len(out) != 1 {
		t.Fatalf("want 1 AMD GPU, got %d (%+v)", len(out), out)
	}
	g := out[0]
	if g.Name != "AMD Radeon RX 6800" || g.Util != 37 || g.MemUsed != 1073741824 || g.MemTotal != 8589934592 || g.Temp != 52 {
		t.Fatalf("amd gpu wrong: %+v", g)
	}
}
