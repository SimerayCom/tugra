package hostinfo

import (
	"os"
	"strings"
	"testing"
)

func TestParseOperatingSystem(t *testing.T) {
	cases := []struct {
		os, ver       string
		wantID, wantV string
		ok            bool
	}{
		{"Ubuntu 26.04.1 LTS", "26.04", "ubuntu", "26.04", true},
		{"Ubuntu 24.04.4 LTS", "", "ubuntu", "24.04.4", true},
		{"Debian GNU/Linux 12 (bookworm)", "12", "debian", "12", true},
		{"Rocky Linux 9.5 (Blue Onyx)", "9.5", "rocky", "9.5", true},
		{"Red Hat Enterprise Linux 9.4 (Plow)", "9.4", "rhel", "9.4", true},
		{"Alpine Linux v3.20", "", "alpine", "3.20", true},
		{"Docker Desktop", "", "", "", false},
		{"", "24.04", "", "", false},
	}
	for _, c := range cases {
		id, v, ok := ParseOperatingSystem(c.os, c.ver)
		if ok != c.ok || id != c.wantID || v != c.wantV {
			t.Errorf("ParseOperatingSystem(%q,%q) = %q,%q,%v; want %q,%q,%v", c.os, c.ver, id, v, ok, c.wantID, c.wantV, c.ok)
		}
	}
}

func TestHostIPArgs(t *testing.T) {
	args, err := HostIPArgs("ghcr.io/simeraycom/tugra-agent:0.1.0-beta.25@sha256:abc")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--rm", "--network host", "--read-only", "--cap-drop ALL", "no-new-privileges", "--entrypoint tugra-agent"} {
		if !strings.Contains(joined, want) {
			t.Errorf("helper argv missing %q: %s", want, joined)
		}
	}
	if args[len(args)-1] != "hostips" {
		t.Errorf("last arg = %q, want hostips", args[len(args)-1])
	}
	for _, bad := range []string{"", "-v", "--privileged", "img; rm -rf /", "img $(id)"} {
		if _, err := HostIPArgs(bad); err == nil {
			t.Errorf("HostIPArgs(%q) accepted an invalid image", bad)
		}
	}
}

func TestReadHostFacts(t *testing.T) {
	dir := t.TempDir()
	p := dir + "/host-facts.json"
	if _, ok := ReadHostFacts(p); ok {
		t.Fatal("missing file must be ok=false")
	}
	body := `{"source":"install","collectedAt":1795444438,"hostname":"olgu-omer-ortak-new","os":"ubuntu","osVersion":"26.04","osPretty":"Ubuntu 26.04.1 LTS","ips":["2.29.218.211","2a01:4f9:c014:8ecc::1","100.85.166.104"]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	hf, ok := ReadHostFacts(p)
	if !ok || hf.Hostname != "olgu-omer-ortak-new" || hf.OS != "ubuntu" || hf.OSVersion != "26.04" || len(hf.IPs) != 3 || hf.IPs[0] != "2.29.218.211" {
		t.Fatalf("ReadHostFacts = %+v, %v", hf, ok)
	}
	if err := os.WriteFile(p, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadHostFacts(p); ok {
		t.Fatal("garbage must be ok=false")
	}
}
