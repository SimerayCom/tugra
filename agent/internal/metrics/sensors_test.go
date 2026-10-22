package metrics

import (
	"testing"

	"github.com/shirou/gopsutil/v4/sensors"
)

func TestPickTempPrefersCPUSensors(t *testing.T) {
	top, m := pickTemp([]sensors.TemperatureStat{
		{SensorKey: "nvme", Temperature: 40},
		{SensorKey: "coretemp_core0", Temperature: 55},
		{SensorKey: "coretemp_core1", Temperature: 61},
		{SensorKey: "bogus", Temperature: 0},  // dropped (<= 0)
		{SensorKey: "bad", Temperature: 999},  // dropped (>= 150)
	})
	if top == nil || *top != 61 {
		t.Fatalf("want hottest CPU sensor 61, got %v", top)
	}
	if len(m) != 3 || m["nvme"] != 40 || m["coretemp_core1"] != 61 {
		t.Fatalf("sensor map wrong: %v", m)
	}
}

func TestPickTempFallsBackToHottestWhenNoCPU(t *testing.T) {
	top, _ := pickTemp([]sensors.TemperatureStat{
		{SensorKey: "nvme", Temperature: 40},
		{SensorKey: "wifi", Temperature: 52},
	})
	if top == nil || *top != 52 {
		t.Fatalf("want overall max 52, got %v", top)
	}
}

func TestPickTempEmptyOrAllInvalid(t *testing.T) {
	if top, m := pickTemp(nil); top != nil || m != nil {
		t.Fatalf("nil input should be nil,nil; got %v %v", top, m)
	}
	if top, m := pickTemp([]sensors.TemperatureStat{{SensorKey: "x", Temperature: 0}}); top != nil || m != nil {
		t.Fatalf("all-invalid should be nil,nil; got %v %v", top, m)
	}
}

func TestPickTempDedupesRepeatedKeys(t *testing.T) {
	_, m := pickTemp([]sensors.TemperatureStat{
		{SensorKey: "acpitz", Temperature: 45},
		{SensorKey: "acpitz", Temperature: 46},
	})
	if len(m) != 2 {
		t.Fatalf("want 2 deduped keys (acpitz, acpitz_1), got %v", m)
	}
}
