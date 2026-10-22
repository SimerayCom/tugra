package metrics

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFile writes a fake sysfs file (shared by the battery and GPU sysfs tests).
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadBatteryPicksSystemBattery(t *testing.T) {
	root := t.TempDir()
	powerSupplyRoot = root
	t.Cleanup(func() { powerSupplyRoot = "/sys/class/power_supply" })
	writeFile(t, filepath.Join(root, "AC", "type"), "Mains\n") // adapter, ignored
	writeFile(t, filepath.Join(root, "BAT0", "type"), "Battery\n")
	writeFile(t, filepath.Join(root, "BAT0", "capacity"), "73\n")
	writeFile(t, filepath.Join(root, "BAT0", "status"), "Discharging\n")
	writeFile(t, filepath.Join(root, "hidpp_battery_0", "type"), "Battery\n") // peripheral, ignored
	writeFile(t, filepath.Join(root, "hidpp_battery_0", "scope"), "Device\n")
	writeFile(t, filepath.Join(root, "hidpp_battery_0", "capacity"), "50\n")

	b := readBattery()
	if b == nil || b.Percent != 73 || b.State != "Discharging" {
		t.Fatalf("want BAT0 73%% Discharging, got %+v", b)
	}
}

func TestReadBatteryNoneOnServer(t *testing.T) {
	powerSupplyRoot = t.TempDir()
	t.Cleanup(func() { powerSupplyRoot = "/sys/class/power_supply" })
	if b := readBattery(); b != nil {
		t.Fatalf("want nil on a host with no battery, got %+v", b)
	}
}
