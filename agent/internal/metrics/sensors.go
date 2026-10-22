package metrics

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/sensors"
)

// cpuSensorHints are hwmon/thermal keys that denote a CPU-package temperature across common platforms
// (Intel coretemp, AMD k10temp/zenpower, ARM/Pi cpu_thermal, the ACPI thermal zone).
var cpuSensorHints = []string{"coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal", "x86_pkg_temp", "acpitz"}

// pickTemp reduces gopsutil's per-sensor list to one headline temperature (the hottest CPU-ish sensor,
// else the hottest of anything) plus a cleaned per-sensor map. It drops NaN/Inf, non-positive and
// out-of-range (>=150 °C) readings (a stuck 0 or a bogus placeholder is common), dedupes repeated keys
// with a _N suffix, caps the map at 16 entries and keys at 32 chars, and returns (nil, nil) when nothing
// usable remains. Pure, so it is table-testable without real hardware.
func pickTemp(stats []sensors.TemperatureStat) (*float64, map[string]float64) {
	out := map[string]float64{}
	seen := map[string]int{}
	var cpuMax, anyMax float64
	var haveCPU, haveAny bool
	for _, st := range stats {
		v := st.Temperature
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v >= 150 {
			continue
		}
		base := strings.TrimSpace(st.SensorKey)
		if base == "" {
			base = "sensor"
		}
		key := base
		if n := seen[base]; n > 0 {
			key = base + "_" + strconv.Itoa(n)
		}
		seen[base]++
		if len(key) > 32 {
			key = key[:32]
		}
		if len(out) < 16 {
			out[key] = v
		}
		lk := strings.ToLower(base)
		for _, h := range cpuSensorHints {
			if strings.Contains(lk, h) {
				if !haveCPU || v > cpuMax {
					cpuMax, haveCPU = v, true
				}
				break
			}
		}
		if !haveAny || v > anyMax {
			anyMax, haveAny = v, true
		}
	}
	if !haveAny {
		return nil, nil
	}
	top := anyMax
	if haveCPU {
		top = cpuMax
	}
	return &top, out
}

// collectTemp reads host temperatures with a timeout and a panic guard — gopsutil can block on a slow
// sysfs read and can panic on a malformed file (gopsutil issue 1832), and the caller runs inline before
// the heartbeat. Returns (nil, nil) when nothing is readable. gopsutil honours HOST_SYS for the sysfs
// root, and returns partial results with a non-nil warning error, which we deliberately keep.
func collectTemp() (*float64, map[string]float64) {
	ch := make(chan []sensors.TemperatureStat, 1)
	go func() {
		defer func() {
			if recover() != nil {
				ch <- nil
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		st, _ := sensors.TemperaturesWithContext(ctx)
		ch <- st
	}()
	select {
	case st := <-ch:
		return pickTemp(st)
	case <-time.After(2500 * time.Millisecond):
		return nil, nil
	}
}
