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
	body := `{"source":"install","collectedAt":1795444438,"hostname":"edge-box-new","os":"ubuntu","osVersion":"26.04","osPretty":"Ubuntu 26.04.1 LTS","ips":["2.29.218.211","2a01:4f9:c014:8ecc::1","100.85.166.104"]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	hf, ok := ReadHostFacts(p)
	if !ok || hf.Hostname != "edge-box-new" || hf.OS != "ubuntu" || hf.OSVersion != "26.04" || len(hf.IPs) != 3 || hf.IPs[0] != "2.29.218.211" {
		t.Fatalf("ReadHostFacts = %+v, %v", hf, ok)
	}
	if err := os.WriteFile(p, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadHostFacts(p); ok {
		t.Fatal("garbage must be ok=false")
	}
}

func TestParseDockerInfoReadsTheEngineID(t *testing.T) {
	h, ok := parseDockerInfo([]byte(`{"Name":"web-1","OperatingSystem":"Ubuntu 24.04.1 LTS","OSVersion":"24.04","ID":"7TRN:IPZB:QYBB:VPBQ:UWTP:KJDG:XWNR:UJTA:6DGX:CYX7:TXQT:XUPF"}`))
	if !ok || h.Hostname != "web-1" || h.OS != "ubuntu" || h.EngineID != "7TRN:IPZB:QYBB:VPBQ:UWTP:KJDG:XWNR:UJTA:6DGX:CYX7:TXQT:XUPF" {
		t.Fatalf("parseDockerInfo = %+v, %v", h, ok)
	}
	// An id that is not shaped like one is dropped, never passed on.
	h, ok = parseDockerInfo([]byte(`{"Name":"web-1","ID":"bad id; rm -rf /"}`))
	if !ok || h.EngineID != "" {
		t.Fatalf("a malformed engine id must be empty: %+v, %v", h, ok)
	}
	// Only an engine id is still an answer (hostname and OS stay empty and the caller keeps its own).
	h, ok = parseDockerInfo([]byte(`{"ID":"ABCD-EFGH-1234"}`))
	if !ok || h.Hostname != "" || h.EngineID != "ABCD-EFGH-1234" {
		t.Fatalf("engine id only: %+v, %v", h, ok)
	}
	if _, ok := parseDockerInfo([]byte(`not json`)); ok {
		t.Fatal("garbage must be ok=false")
	}
}

func TestCleanIdentityFacts(t *testing.T) {
	good := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if CleanMachineIDHash(good) != good || CleanMachineIDHash(" "+strings.ToUpper(good)+"\n") != good {
		t.Fatal("a 64 hex hash is kept (lower-cased, trimmed)")
	}
	for _, bad := range []string{"", "abc", good[:63], good + "0", "g" + good[1:], "0123456789abcdef0123456789abcdef"} {
		if CleanMachineIDHash(bad) != "" {
			t.Errorf("CleanMachineIDHash(%q) accepted a non-hash", bad)
		}
	}
	for _, bad := range []string{"", "short", "has space in it", "semi;colon-id-xx", strings.Repeat("a", 129)} {
		if CleanEngineID(bad) != "" {
			t.Errorf("CleanEngineID(%q) accepted a bad id", bad)
		}
	}
}

func TestReadHostFactsCarriesTheHashedMachineID(t *testing.T) {
	p := t.TempDir() + "/host-facts.json"
	good := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := os.WriteFile(p, []byte(`{"source":"install","hostname":"h","machineIdHash":"`+good+`","ips":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	hf, ok := ReadHostFacts(p)
	if !ok || CleanMachineIDHash(hf.MachineIDHash) != good {
		t.Fatalf("ReadHostFacts = %+v, %v", hf, ok)
	}
	// An older facts file has no field: empty, not an error.
	if err := os.WriteFile(p, []byte(`{"source":"install","hostname":"h","ips":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	hf, ok = ReadHostFacts(p)
	if !ok || CleanMachineIDHash(hf.MachineIDHash) != "" {
		t.Fatalf("old file: %+v, %v", hf, ok)
	}
}

func TestCleanSSHHostKeyFingerprints(t *testing.T) {
	good := "SHA256:" + strings.Repeat("A", 43)
	other := "SHA256:" + strings.Repeat("b", 43)
	if CleanSSHHostKeyFp(" "+good+"\n") != good {
		t.Fatal("a fingerprint is kept, trimmed")
	}
	for _, bad := range []string{"", "SHA256:", "MD5:" + strings.Repeat("a", 43), good + "=", "SHA256:" + strings.Repeat("A", 42), "SHA256:" + strings.Repeat("A", 42) + ";", "sha256:" + strings.Repeat("A", 43)} {
		if CleanSSHHostKeyFp(bad) != "" {
			t.Errorf("CleanSSHHostKeyFp(%q) accepted a non-fingerprint", bad)
		}
	}
	got := CleanSSHHostKeyFps([]string{good, "junk", other, good, good + "x", other, "SHA256:" + strings.Repeat("c", 43), "SHA256:" + strings.Repeat("d", 43), "SHA256:" + strings.Repeat("e", 43)})
	if len(got) != 4 || got[0] != good || got[1] != other {
		t.Fatalf("list = %v", got)
	}
}

func TestReadHostFactsCarriesTheSshdFingerprints(t *testing.T) {
	p := t.TempDir() + "/host-facts.json"
	good := "SHA256:" + strings.Repeat("A", 43)
	if err := os.WriteFile(p, []byte(`{"source":"install","hostname":"h","sshHostKeyFp":"`+good+`","sshHostKeyFps":["`+good+`"],"ips":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	hf, ok := ReadHostFacts(p)
	if !ok || CleanSSHHostKeyFp(hf.SSHHostKeyFp) != good || len(hf.SSHHostKeyFps) != 1 {
		t.Fatalf("ReadHostFacts = %+v, %v", hf, ok)
	}
	// an older facts file has none: empty, not an error
	if err := os.WriteFile(p, []byte(`{"source":"install","hostname":"h","ips":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	hf, ok = ReadHostFacts(p)
	if !ok || hf.SSHHostKeyFp != "" || len(hf.SSHHostKeyFps) != 0 {
		t.Fatalf("old file: %+v, %v", hf, ok)
	}
}
