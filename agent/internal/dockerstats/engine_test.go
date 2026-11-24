package dockerstats

import (
	"context"
	"testing"
	"time"
)

func TestEngineSocket(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", "/var/run/docker.sock"},
		{"unix:///run/user/1000/docker.sock", "/run/user/1000/docker.sock"},
		{"tcp://10.0.0.1:2375", ""},
		{"ssh://root@example.com", ""},
	} {
		if got := engineSocket(c.in); got != c.want {
			t.Errorf("engineSocket(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseEngineStatsSumsInterfacesAndBlockOps(t *testing.T) {
	body := []byte(`{
	  "networks": {"eth0": {"rx_bytes": 1000, "tx_bytes": 200}, "eth1": {"rx_bytes": 24, "tx_bytes": 6}},
	  "blkio_stats": {"io_service_bytes_recursive": [
	    {"major": 8, "minor": 0, "op": "read", "value": 4096},
	    {"major": 8, "minor": 0, "op": "Write", "value": 8192},
	    {"major": 8, "minor": 16, "op": "read", "value": 4},
	    {"major": 8, "minor": 0, "op": "Total", "value": 99999}
	  ]}
	}`)
	got, err := parseEngineStats(body)
	if err != nil {
		t.Fatal(err)
	}
	want := exactIO{netRx: 1024, netTx: 206, blkRead: 4100, blkWrite: 8192}
	if got != want {
		t.Errorf("parseEngineStats = %+v, want %+v", got, want)
	}
}

func TestParseEngineStatsHostNetworkHasNoInterfaces(t *testing.T) {
	got, err := parseEngineStats([]byte(`{"blkio_stats":{}}`))
	if err != nil || got != (exactIO{}) {
		t.Errorf("got %+v, %v; want zero, nil", got, err)
	}
	if _, err := parseEngineStats([]byte(`not json`)); err == nil {
		t.Error("malformed payload must error")
	}
}

type fakeIO map[string]exactIO

func (f fakeIO) IO(_ context.Context, id string) (exactIO, bool) {
	v, ok := f[id]
	return v, ok
}

func TestFetchExactSkipsUnreachableContainers(t *testing.T) {
	src := fakeIO{"a": {netRx: 5}, "b": {netTx: 7}}
	got := fetchExact(context.Background(), src, []string{"a", "b", "gone"})
	if len(got) != 2 || got["a"].netRx != 5 || got["b"].netTx != 7 {
		t.Errorf("fetchExact = %+v", got)
	}
	if out := fetchExact(context.Background(), nil, []string{"a"}); len(out) != 0 {
		t.Errorf("nil source must yield nothing, got %+v", out)
	}
}

// The regression this file fixes: docker prints "1.23GB" for BOTH samples while the container moved 3 MB, so
// the CLI-derived rate is 0. With exact counters the rate is real.
func TestIngestUsesExactCountersWhenAvailable(t *testing.T) {
	c := NewCollector()
	line := `{"BlockIO":"1.23GB / 1.23GB","CPUPerc":"1%","Container":"x","ID":"x1","MemPerc":"1%","MemUsage":"1MiB / 1GiB","Name":"web","NetIO":"1.23GB / 1.23GB","PIDs":"1"}`

	c.exact = map[string]exactIO{"x1": {netRx: 1_230_000_000, netTx: 1_230_000_000, blkRead: 1_230_000_000, blkWrite: 1_230_000_000}}
	c.ingest([]byte(line), time.Unix(0, 0))

	c.exact = map[string]exactIO{"x1": {netRx: 1_233_000_000, netTx: 1_231_500_000, blkRead: 1_230_000_000, blkWrite: 1_236_000_000}}
	out := c.ingest([]byte(line), time.Unix(15, 0))
	if len(out) != 1 {
		t.Fatalf("want 1 stat, got %d", len(out))
	}
	s := out[0]
	if !approx(s.NetRx, 200_000) || !approx(s.NetTx, 100_000) || !approx(s.BlkRead, 0) || !approx(s.BlkWrite, 400_000) {
		t.Errorf("exact rates wrong: %+v", s)
	}

	// Same two samples through the CLI strings alone: the rounded values are identical → 0 (the old bug).
	cli := NewCollector()
	cli.ingest([]byte(line), time.Unix(0, 0))
	if s := cli.ingest([]byte(line), time.Unix(15, 0))[0]; s.NetRx != 0 {
		t.Errorf("CLI-only rate should be 0 for identical rounded strings, got %v", s.NetRx)
	}
}

func TestIngestAttachesLabelsByContainerName(t *testing.T) {
	c := NewCollector()
	c.labels = parseLabels([]byte("web\tuuid-1\tBlog\tAcme Site\tproduction\tphp\n"))
	out := c.ingest([]byte(fixtureLine), time.Unix(0, 0))
	if out[0].Meta == nil || out[0].Meta.Resource != "Blog" || out[0].Meta.Project != "Acme Site" || out[0].Meta.Service != "php" {
		t.Errorf("meta not attached: %+v", out[0].Meta)
	}
	c2 := NewCollector()
	if out := c2.ingest([]byte(fixtureLine), time.Unix(0, 0)); out[0].Meta != nil {
		t.Errorf("no labels → no meta, got %+v", out[0].Meta)
	}
}

func TestParseLabels(t *testing.T) {
	got := parseLabels([]byte("a\tn1\t\t\t\t\nb\t\t\t\t\t\nc\t\t\tproj\t\tsvc\nshort\tline\n\n"))
	if len(got) != 2 {
		t.Fatalf("want 2 labelled containers, got %+v", got)
	}
	if got["a"].Name != "n1" || got["c"].Project != "proj" || got["c"].Service != "svc" {
		t.Errorf("parsed wrong: %+v %+v", got["a"], got["c"])
	}
	if _, ok := got["b"]; ok {
		t.Error("container with no labels must be omitted")
	}
	long := make([]byte, 0, 300)
	for i := 0; i < 300; i++ {
		long = append(long, 'x')
	}
	if m := parseLabels([]byte("z\t" + string(long) + "\t\t\t\t\n")); len(m["z"].Name) != maxLabelLen {
		t.Errorf("label not clipped to %d: %d", maxLabelLen, len(m["z"].Name))
	}
}
