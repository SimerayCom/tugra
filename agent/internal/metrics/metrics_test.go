package metrics

import "testing"

func TestCollect(t *testing.T) {
	s, err := Collect()
	if err != nil {
		t.Fatal(err)
	}
	if s.MemTotal <= 0 {
		t.Fatalf("expected positive memTotal, got %v", s.MemTotal)
	}
	if s.CPU < 0 || s.CPU > 100 {
		t.Fatalf("cpu out of range: %v", s.CPU)
	}
	if s.Ts <= 0 {
		t.Fatal("expected a timestamp")
	}
}

func TestNetRate(t *testing.T) {
	cases := []struct {
		name                         string
		prevRx, prevTx, curRx, curTx uint64
		elapsed                      float64
		wantRx, wantTx               float64
	}{
		{"normal rate", 1000, 2000, 3000, 5000, 2, 1000, 1500},
		{"zero elapsed", 1000, 2000, 3000, 5000, 0, 0, 0},
		{"negative elapsed", 1000, 2000, 3000, 5000, -1, 0, 0},
		{"rx counter reset only", 5000, 2000, 100, 5000, 2, 0, 1500},
		{"both counters reset", 5000, 6000, 100, 200, 2, 0, 0},
		{"no traffic", 1000, 2000, 1000, 2000, 2, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rx, tx := netRate(c.prevRx, c.prevTx, c.curRx, c.curTx, c.elapsed)
			if rx != c.wantRx {
				t.Errorf("rx: got %v, want %v", rx, c.wantRx)
			}
			if tx != c.wantTx {
				t.Errorf("tx: got %v, want %v", tx, c.wantTx)
			}
		})
	}
}

func TestIsVirtualNIC(t *testing.T) {
	virtual := []string{"lo", "lo0", "veth1a2b", "docker0", "docker_gwbridge", "br-abc123", "virbr0"}
	for _, n := range virtual {
		if !isVirtualNIC(n) {
			t.Errorf("expected %q to be virtual", n)
		}
	}
	real := []string{"eth0", "ens3", "enp0s3", "en0", "wlan0", "br0"}
	for _, n := range real {
		if isVirtualNIC(n) {
			t.Errorf("expected %q to be a real interface", n)
		}
	}
}

func TestCollectorFirstSampleNetZero(t *testing.T) {
	c := NewCollector()
	s, err := c.Sample()
	if err != nil {
		t.Fatal(err)
	}
	// No prior baseline on the first sample, so a rate cannot be computed yet.
	if s.NetRx != 0 || s.NetTx != 0 {
		t.Fatalf("expected zero net on first sample, got rx=%v tx=%v", s.NetRx, s.NetTx)
	}
	// The stateless fields still come through.
	if s.MemTotal <= 0 {
		t.Fatalf("expected positive memTotal, got %v", s.MemTotal)
	}
}

func TestCollectorSecondSampleNonNegative(t *testing.T) {
	c := NewCollector()
	if _, err := c.Sample(); err != nil {
		t.Fatal(err)
	}
	s, err := c.Sample()
	if err != nil {
		t.Fatal(err)
	}
	// Real host counters only ever move forward between samples, so with a
	// baseline in place the derived rate must be non-negative.
	if s.NetRx < 0 || s.NetTx < 0 {
		t.Fatalf("expected non-negative net rate, got rx=%v tx=%v", s.NetRx, s.NetTx)
	}
}
