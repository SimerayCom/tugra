package dockerstats

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestParseBytes(t *testing.T) {
	cases := []struct {
		in   string
		want float64
	}{
		{"0B", 0},
		{"512B", 512},
		{"1.5kB", 1500},        // SI kilo (net/block IO)
		{"3.4MB", 3_400_000},   // SI mega
		{"2GB", 2_000_000_000}, // SI giga
		{"10.5MiB", 10.5 * 1024 * 1024},
		{"1.9GiB", 1.9 * 1024 * 1024 * 1024},
		{"8.19kB", 8190},
		{"1KiB", 1024},
		{"  4MiB  ", 4 * 1024 * 1024}, // surrounding whitespace
		{"", 0},
		{"garbage", 0},
	}
	for _, c := range cases {
		if got := parseBytes(c.in); !approx(got, c.want) {
			t.Errorf("parseBytes(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestParsePct(t *testing.T) {
	for _, c := range []struct {
		in   string
		want float64
	}{{"0.15%", 0.15}, {"55.00%", 55}, {" 3.2% ", 3.2}, {"--", 0}, {"", 0}} {
		if got := parsePct(c.in); !approx(got, c.want) {
			t.Errorf("parsePct(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestParseUsage(t *testing.T) {
	used, total := parseUsage("10.5MiB / 1.9GiB")
	if !approx(used, 10.5*1024*1024) || !approx(total, 1.9*1024*1024*1024) {
		t.Errorf("parseUsage mem = %v / %v", used, total)
	}
	rx, tx := parseUsage("1.2kB / 3.4MB")
	if !approx(rx, 1200) || !approx(tx, 3_400_000) {
		t.Errorf("parseUsage net = %v / %v", rx, tx)
	}
	// malformed -> zeros, no panic
	if a, b := parseUsage("no-slash"); a != 0 || b != 0 {
		t.Errorf("parseUsage(malformed) = %v / %v", a, b)
	}
}

func TestRate(t *testing.T) {
	if got := rate(100, 300, 2); !approx(got, 100) { // (300-100)/2 = 100 B/s
		t.Errorf("rate normal = %v, want 100", got)
	}
	if got := rate(500, 100, 2); got != 0 { // counter reset (container restart) -> 0
		t.Errorf("rate reset = %v, want 0", got)
	}
	if got := rate(100, 300, 0); got != 0 { // zero elapsed -> 0
		t.Errorf("rate zero-elapsed = %v, want 0", got)
	}
}

const fixtureLine = `{"BlockIO":"0B / 8.19kB","CPUPerc":"0.15%","Container":"abc","ID":"abc123","MemPerc":"0.55%","MemUsage":"10.5MiB / 1.9GiB","Name":"web","NetIO":"1.2kB / 3.4MB","PIDs":"5"}`

func TestIngestFirstSampleZeroRates(t *testing.T) {
	c := NewCollector()
	out := c.ingest([]byte(fixtureLine), time.Unix(0, 0))
	if len(out) != 1 {
		t.Fatalf("want 1 stat, got %d", len(out))
	}
	s := out[0]
	if s.Name != "web" || s.ID != "abc123" {
		t.Errorf("bad id/name: %+v", s)
	}
	if !approx(s.CPU, 0.15) || !approx(s.MemPct, 0.55) {
		t.Errorf("bad pct: cpu=%v mem=%v", s.CPU, s.MemPct)
	}
	if !approx(s.MemUsed, 10.5*1024*1024) || !approx(s.MemTotal, 1.9*1024*1024*1024) {
		t.Errorf("bad mem: %v / %v", s.MemUsed, s.MemTotal)
	}
	// First sample has no baseline -> all rates 0 even though NetIO/BlockIO are non-zero cumulatives.
	if s.NetRx != 0 || s.NetTx != 0 || s.BlkRead != 0 || s.BlkWrite != 0 {
		t.Errorf("first sample should have zero rates, got %+v", s)
	}
}

func TestIngestRateDelta(t *testing.T) {
	c := NewCollector()
	// t0: cumulative net rx=1000B, tx=2000B; block read=0, write=8000B
	line0 := `{"BlockIO":"0B / 8kB","CPUPerc":"1%","Container":"x","ID":"x1","MemPerc":"1%","MemUsage":"1MiB / 1GiB","Name":"web","NetIO":"1kB / 2kB","PIDs":"1"}`
	c.ingest([]byte(line0), time.Unix(0, 0))
	// t1 (+2s): net rx=5000B (+4000/2s=2000B/s), tx=2000B (0), block read=0, write=16000B (+8000/2s=4000B/s)
	line1 := `{"BlockIO":"0B / 16kB","CPUPerc":"1%","Container":"x","ID":"x1","MemPerc":"1%","MemUsage":"1MiB / 1GiB","Name":"web","NetIO":"5kB / 2kB","PIDs":"1"}`
	out := c.ingest([]byte(line1), time.Unix(2, 0))
	s := out[0]
	if !approx(s.NetRx, 2000) {
		t.Errorf("NetRx = %v, want 2000", s.NetRx)
	}
	if !approx(s.NetTx, 0) {
		t.Errorf("NetTx = %v, want 0", s.NetTx)
	}
	if !approx(s.BlkWrite, 4000) {
		t.Errorf("BlkWrite = %v, want 4000", s.BlkWrite)
	}
}

func TestIngestCounterResetOnRestart(t *testing.T) {
	c := NewCollector()
	// container has accumulated traffic...
	c.ingest([]byte(`{"BlockIO":"0B / 0B","CPUPerc":"1%","Container":"x","ID":"x1","MemPerc":"1%","MemUsage":"1MiB / 1GiB","Name":"web","NetIO":"100kB / 100kB","PIDs":"1"}`), time.Unix(0, 0))
	// ...then restarts: same NAME, new ID, cumulative counters reset to near-zero.
	out := c.ingest([]byte(`{"BlockIO":"0B / 0B","CPUPerc":"1%","Container":"x","ID":"x2new","MemPerc":"1%","MemUsage":"1MiB / 1GiB","Name":"web","NetIO":"1kB / 1kB","PIDs":"1"}`), time.Unix(2, 0))
	s := out[0]
	if s.ID != "x2new" {
		t.Errorf("ID should track restart: %q", s.ID)
	}
	// cur(1kB) < prev(100kB) -> guarded to 0, not a huge negative/positive spike.
	if s.NetRx != 0 || s.NetTx != 0 {
		t.Errorf("counter-reset rates should be 0, got rx=%v tx=%v", s.NetRx, s.NetTx)
	}
}

func TestIngestMalformedLineSkipped(t *testing.T) {
	c := NewCollector()
	payload := "not json\n" + fixtureLine + "\n{bad"
	out := c.ingest([]byte(payload), time.Unix(0, 0))
	if len(out) != 1 || out[0].Name != "web" {
		t.Errorf("malformed lines should be skipped, got %d stats", len(out))
	}
}

func TestIngestEmptyOutput(t *testing.T) {
	c := NewCollector()
	if out := c.ingest([]byte("   \n  "), time.Unix(0, 0)); len(out) != 0 {
		t.Errorf("empty output should yield no stats, got %d", len(out))
	}
}

func TestIngestCapTruncates(t *testing.T) {
	c := NewCollector()
	var b strings.Builder
	for i := 0; i < maxContainers+50; i++ {
		fmt.Fprintf(&b, `{"BlockIO":"0B / 0B","CPUPerc":"1%%","Container":"c%d","ID":"id%d","MemPerc":"1%%","MemUsage":"1MiB / 1GiB","Name":"c%d","NetIO":"0B / 0B","PIDs":"1"}`+"\n", i, i, i)
	}
	out := c.ingest([]byte(b.String()), time.Unix(0, 0))
	if len(out) != maxContainers {
		t.Errorf("cap should truncate the EMITTED batch to %d, got %d", maxContainers, len(out))
	}
	// ...but the rate baseline must be retained for ALL parsed containers, so a container beyond
	// the cap doesn't lose its baseline and read a bogus 0 rate when it re-enters the emitted set.
	if len(c.prev) != maxContainers+50 {
		t.Errorf("baseline should cover all %d parsed containers, got %d", maxContainers+50, len(c.prev))
	}
}

func TestIngestCapKeepsRateForContainerReenteringEmittedSet(t *testing.T) {
	c := NewCollector()
	// Tick 0: a container "tail" sits PAST the cap (so it isn't emitted) but must still be baselined.
	var b strings.Builder
	for i := 0; i < maxContainers; i++ {
		fmt.Fprintf(&b, `{"BlockIO":"0B / 0B","CPUPerc":"1%%","Container":"c%d","ID":"id%d","MemPerc":"1%%","MemUsage":"1MiB / 1GiB","Name":"c%d","NetIO":"0B / 0B","PIDs":"1"}`+"\n", i, i, i)
	}
	b.WriteString(`{"BlockIO":"0B / 0B","CPUPerc":"1%","Container":"tail","ID":"idt","MemPerc":"1%","MemUsage":"1MiB / 1GiB","Name":"tail","NetIO":"1kB / 0B","PIDs":"1"}` + "\n")
	c.ingest([]byte(b.String()), time.Unix(0, 0))
	// Tick 1 (+2s): "tail" now appears alone (within the cap) with more traffic. Because it was
	// baselined in tick 0, its rate is computed rather than silently 0.
	out := c.ingest([]byte(`{"BlockIO":"0B / 0B","CPUPerc":"1%","Container":"tail","ID":"idt","MemPerc":"1%","MemUsage":"1MiB / 1GiB","Name":"tail","NetIO":"5kB / 0B","PIDs":"1"}`), time.Unix(2, 0))
	if len(out) != 1 || out[0].Name != "tail" {
		t.Fatalf("expected tail emitted, got %+v", out)
	}
	if !approx(out[0].NetRx, 2000) { // (5kB-1kB)/2s = 2000 B/s
		t.Errorf("tail NetRx = %v, want 2000 (baseline retained past cap)", out[0].NetRx)
	}
}

func TestReentrancyGuard(t *testing.T) {
	c := NewCollector()
	c.inFlight = true
	got, err := c.Sample(nil)
	if err != nil || got != nil {
		t.Errorf("reentrant Sample should return (nil,nil), got (%v,%v)", got, err)
	}
}
