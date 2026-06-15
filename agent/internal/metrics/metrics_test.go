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
