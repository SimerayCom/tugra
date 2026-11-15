package migrate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// testToken: shared with acme_test.go

// stubDockerOnPath makes `lookDocker` succeed; every docker call the code makes goes through the stubbed runDocker.
func stubDockerOnPath(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

// vxHub is a scripted hub for the volume arm: targets, inventory and disk-check (dry-run), recording every call.
type vxHub struct {
	mu       sync.Mutex
	targets  string
	disk     string // the /disk-check JSON answer
	calls    []string
	inv      invReq
	diskReqs map[string]diskReq
}

func (h *vxHub) handler(t *testing.T) http.Handler {
	h.diskReqs = map[string]diskReq{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, "/api/v1/import/migration/")
		h.calls = append(h.calls, r.Method+" "+p)
		b, _ := io.ReadAll(r.Body)
		switch {
		case p == "probe":
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case p == "recipes":
			spec := engineSpecs["POSTGRES"]
			io.WriteString(w, `{"v":1,"recipes":{"POSTGRES":{"command":`+jsonStr(spec.golden)+`,"format":"pg_custom","pgFormat":"custom","env":[{"name":"PGPASSWORD","from":"pw"}]}},"unsupported":{}}`)
		case p == "targets":
			io.WriteString(w, h.targets)
		case p == "vx/inventory":
			_ = json.Unmarshal(b, &h.inv)
			fmt.Fprintf(w, `{"stored":%d,"expiresAt":"2999-01-01T00:00:00Z"}`, len(h.inv.Items))
		case strings.HasSuffix(p, "/disk-check"):
			var d diskReq
			_ = json.Unmarshal(b, &d)
			ref := strings.TrimSuffix(strings.TrimPrefix(p, "vx/"), "/disk-check")
			h.diskReqs[ref] = d
			io.WriteString(w, h.disk)
		default:
			w.WriteHeader(404)
		}
	})
}

func (h *vxHub) called(prefix string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.calls {
		if strings.Contains(c, prefix) {
			return true
		}
	}
	return false
}

func volTargetsJSON(extra ...string) string {
	rows := []string{
		`{"itemRef":"volume:srv1:5f3a9c:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"app-volume","name":"data","mountPath":"/var/www/data"},"appItemRef":"app:srv1:5f3a9c"}`,
	}
	rows = append(rows, extra...)
	return `{"opId":"op1","targets":[` + strings.Join(rows, ",") + `],"maxArtifactBytes":268435456,"maxVolumeBytes":268435456,"vxProtocol":1,"vx":{"partRawBytes":134217728,"maxBytes":274877906944,"maxParts":100000}}`
}

func runVol(t *testing.T, srv *httptest.Server, args ...string) (output, int, string) {
	t.Helper()
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	var stdout, stderr bytes.Buffer
	code := RunCLI(append([]string{"--hub", srv.URL}, args...), "test", &stdout, &stderr)
	var out output
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil {
		t.Fatalf("stdout is not one JSON line: %v\n%s", err, stdout.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), "tugra_mig_aaaa") {
		t.Error("the token leaked")
	}
	return out, code, stderr.String()
}

func TestVolumeDryRunReportsInventoryAndNeverMovesAnything(t *testing.T) {
	stubDockerOnPath(t)
	hub := &vxHub{targets: volTargetsJSON(), disk: `{"ok":true,"unknown":false,"details":{"totalBytes":5}}`}
	srv := httptest.NewServer(hub.handler(t))
	defer srv.Close()
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: "TUGRA_INV bytes=5368709120 entries=42 sockets=1 fifos=0 devices=0 pgv=- nested=-\n"}
	d.install(t)

	out, code, stderr := runVol(t, srv, "--arms", "volumes", "--dry-run", "--helper-image", "img:1")
	if code != exitOK || !out.DryRun || out.OK != true {
		t.Fatalf("exit=%d out=%+v stderr=%s", code, out, stderr)
	}
	if len(out.Items) != 1 {
		t.Fatalf("items: %+v", out.Items)
	}
	it := out.Items[0]
	if it.State != "planned" || it.Reason != "would-migrate" || it.RawBytes != 5368709120 || it.Entries != 42 || it.Disk != "ok" || it.Running == nil || *it.Running || it.Engine != "VOLUME" {
		t.Errorf("item: %+v", it)
	}
	if len(d.stopCalls) != 0 || len(d.startCalls) != 0 {
		t.Error("a dry run must never stop or start anything")
	}
	for _, c := range []string{"/begin", "/parts", "/finish", "artifacts/"} {
		if hub.called(c) {
			t.Errorf("a dry run must not call %s: %v", c, hub.calls)
		}
	}
	// the inventory the hub got carries the honest facts
	if len(hub.inv.Items) != 1 {
		t.Fatalf("inventory: %+v", hub.inv)
	}
	inv := hub.inv.Items[0]
	if !inv.Found || inv.RawBytes != 5368709120 || inv.Specials.Sockets != 1 || inv.Image != "ghcr.io/x/web:1" || inv.MountDest != "/var/www/data" || inv.Running || inv.ExitCode == nil {
		t.Errorf("inventory item: %+v", inv)
	}
	if hub.diskReqs["volume:srv1:5f3a9c:data"].RawBytes == nil || *hub.diskReqs["volume:srv1:5f3a9c:data"].RawBytes != 5368709120 {
		t.Errorf("disk-check must carry the measured size: %+v", hub.diskReqs)
	}
	// the helper never pulls and runs with the hardened flags
	argv := strings.Join(d.runCalls[0], " ")
	if !strings.Contains(argv, "--pull=never") || !strings.Contains(argv, "--cap-drop ALL") {
		t.Errorf("helper argv: %s", argv)
	}
}

func TestVolumeDryRunRunningSourceAndStopSource(t *testing.T) {
	stubDockerOnPath(t)
	hub := &vxHub{targets: volTargetsJSON(), disk: `{"ok":true,"unknown":false,"details":{}}`}
	srv := httptest.NewServer(hub.handler(t))
	defer srv.Close()
	c := stoppedApp()
	c.running = true
	d := &volDocker{ctrs: []*vctr{c}, invOut: "TUGRA_INV bytes=10 entries=1 sockets=0 fifos=0 devices=0 pgv=- nested=-\n"}
	d.install(t)

	out, code, _ := runVol(t, srv, "--arms", "volumes", "--dry-run", "--helper-image", "img:1")
	if code != exitPartial || out.Items[0].State != "volume-skipped-running" || !strings.Contains(out.Items[0].Reason, "stop 5f3a9c-170000000000 first") || out.Counts.Skipped != 1 {
		t.Errorf("running source: code=%d %+v", code, out.Items)
	}
	out, code, _ = runVol(t, srv, "--arms", "volumes", "--dry-run", "--stop-source", "--helper-image", "img:1")
	if code != exitOK || out.Items[0].State != "planned" || out.Items[0].Reason != "would-stop-source" {
		t.Errorf("--stop-source dry-run: code=%d %+v", code, out.Items)
	}
	if len(d.stopCalls) != 0 {
		t.Error("dry-run --stop-source must not stop")
	}
}

func TestVolumeDryRunRefusals(t *testing.T) {
	stubDockerOnPath(t)
	excluded := `{"itemRef":"volume:srv1:clk:data","kind":"volume","volumeIngest":"excluded","reason":"58 GB ClickHouse excluded by the owner","dest":{"type":"app-volume","name":"data","mountPath":"/var/lib/clickhouse"},"appItemRef":"app:srv1:clk"}`
	bind := `{"itemRef":"volume:srv1:bnd:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"app-volume","name":"data","mountPath":"/media"},"appItemRef":"app:srv1:bnd"}`
	missing := `{"itemRef":"volume:srv1:gone:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"app-volume","name":"data","mountPath":"/x"},"appItemRef":"app:srv1:gone"}`
	hub := &vxHub{targets: volTargetsJSON(excluded, bind, missing), disk: `{"ok":false,"unknown":false,"details":{}}`}
	srv := httptest.NewServer(hub.handler(t))
	defer srv.Close()
	bc := &vctr{id: otherID, name: "bnd-170000000000", image: "x", mounts: []dockerMount{{Type: "bind", Source: "/srv/media", Destination: "/media"}}}
	d := &volDocker{ctrs: []*vctr{stoppedApp(), bc}, invOut: "TUGRA_INV bytes=7 entries=1 sockets=0 fifos=0 devices=0 pgv=- nested=-\n"}
	d.install(t)

	out, code, _ := runVol(t, srv, "--arms", "volumes", "--dry-run", "--helper-image", "img:1")
	if code != exitPartial {
		t.Errorf("exit=%d", code)
	}
	got := map[string]itemResult{}
	for _, it := range out.Items {
		got[it.ItemRef] = it
	}
	if r := got["volume:srv1:clk:data"]; r.State != "volume-not-migrated" || !strings.Contains(r.Reason, "58 GB ClickHouse") {
		t.Errorf("an explicit exclusion must be reported, never silent: %+v", r)
	}
	if r := got["volume:srv1:bnd:data"]; r.State != "volume-bind-refused" {
		t.Errorf("bind without --allow-bind: %+v", r)
	}
	if r := got["volume:srv1:gone:data"]; r.State != "volume-source-missing" {
		t.Errorf("unresolved volume: %+v", r)
	}
	if r := got["volume:srv1:5f3a9c:data"]; r.State != "volume-disk-insufficient" || r.Disk != "short" {
		t.Errorf("a short target disk is reported in the dry-run: %+v", r)
	}
	// the missing volume is still reported to the hub (found=false); the excluded one is not inventoried
	var refs []string
	for _, it := range hub.inv.Items {
		refs = append(refs, it.ItemRef)
	}
	if strings.Contains(strings.Join(refs, ","), "clk") || !strings.Contains(strings.Join(refs, ","), "gone") {
		t.Errorf("inventory refs: %v", refs)
	}
}

func TestVolumeDryRunSpecialFilesRefused(t *testing.T) {
	stubDockerOnPath(t)
	hub := &vxHub{targets: volTargetsJSON(), disk: `{"ok":true,"unknown":false,"details":{}}`}
	srv := httptest.NewServer(hub.handler(t))
	defer srv.Close()
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: "TUGRA_INV bytes=7 entries=3 sockets=0 fifos=0 devices=2 pgv=- nested=-\n"}
	d.install(t)
	out, _, _ := runVol(t, srv, "--arms", "volumes", "--dry-run", "--helper-image", "img:1")
	if out.Items[0].State != "volume-special-files" {
		t.Errorf("device nodes refuse the copy: %+v", out.Items[0])
	}
}

func TestPostgresDryRunReportsImageMajorLayoutMount(t *testing.T) {
	stubDockerOnPath(t)
	row := `{"itemRef":"volume:srv1:pg7c1:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"db-data","name":"data","mountPath":"/var/lib/postgresql/data"},"databaseItemRef":"database:srv1:pg7c1","engine":"POSTGRES","engineVersion":"18","sourceImage":"postgres:18-alpine"}`
	hub := &vxHub{targets: `{"opId":"op1","targets":[` + row + `],"maxArtifactBytes":1,"vxProtocol":1,"vx":{"partRawBytes":134217728,"maxBytes":274877906944,"maxParts":100000}}`, disk: `{"ok":true,"unknown":false,"details":{}}`}
	srv := httptest.NewServer(hub.handler(t))
	defer srv.Close()
	pg := &vctr{id: dbCtrID, name: "pg7c1", image: "postgres:18-alpine", exit: 137, mounts: []dockerMount{{Type: "volume", Name: "pg_data", Destination: "/var/lib/postgresql"}}}
	d := &volDocker{ctrs: []*vctr{pg}, invOut: "TUGRA_INV bytes=31800000000 entries=999 sockets=0 fifos=0 devices=0 pgv=- nested=18\n"}
	d.install(t)
	out, _, _ := runVol(t, srv, "--arms", "volumes", "--dry-run", "--helper-image", "img:1")
	inv := hub.inv.Items[0]
	if inv.Image != "postgres:18-alpine" || inv.PgMajor != "18" || inv.PgLayout != "nested" || inv.MountDest != "/var/lib/postgresql" || inv.ExitCode == nil || *inv.ExitCode != 137 {
		t.Errorf("the dry-run must report image/major/layout/mount so the hub can decide the physical-copy gates: %+v", inv)
	}
	if out.Items[0].Engine != "POSTGRES" || out.Items[0].PgLayout != "nested" || out.Items[0].PgMajor != "18" {
		t.Errorf("item: %+v", out.Items[0])
	}
	// the tar excludes the postmaster lock: the inventory counted without it
	if !strings.Contains(strings.Join(d.runCalls[0], " "), "! -path /data/postmaster.pid") {
		t.Error("db-data inventory must exclude postmaster.pid")
	}
}

func TestArmsSelection(t *testing.T) {
	stubDockerOnPath(t)
	mixed := `{"opId":"op1","targets":[{"itemRef":"database:_:mypg","kind":"database","engine":"POSTGRES"},{"itemRef":"volume:srv1:5f3a9c:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"app-volume","name":"data","mountPath":"/x"}}],"maxArtifactBytes":268435456,"vxProtocol":1,"vx":{"partRawBytes":134217728,"maxBytes":100,"maxParts":10}}`
	t.Run("default arm never touches a volume row", func(t *testing.T) {
		hub := &vxHub{targets: mixed}
		srv := httptest.NewServer(hub.handler(t))
		defer srv.Close()
		(&volDocker{}).install(t)
		out, _, _ := runVol(t, srv, "--dry-run")
		if len(out.Items) != 1 || out.Items[0].ItemRef != "database:_:mypg" || hub.called("vx/") {
			t.Errorf("default must stay databases-only: %+v calls=%v", out.Items, hub.calls)
		}
	})
	t.Run("--arms volumes ignores databases", func(t *testing.T) {
		hub := &vxHub{targets: mixed, disk: `{"ok":true,"unknown":false,"details":{}}`}
		srv := httptest.NewServer(hub.handler(t))
		defer srv.Close()
		(&volDocker{ctrs: []*vctr{{id: appCtrID, name: "5f3a9c", mounts: []dockerMount{{Type: "volume", Name: "v", Destination: "/x"}}}}, invOut: "TUGRA_INV bytes=1 entries=1 sockets=0 fifos=0 devices=0 pgv=- nested=-\n"}).install(t)
		out, _, _ := runVol(t, srv, "--arms", "volumes", "--dry-run", "--helper-image", "img:1")
		if len(out.Items) != 1 || out.Items[0].ItemRef != "volume:srv1:5f3a9c:data" {
			t.Errorf("items: %+v", out.Items)
		}
	})
	t.Run("an old hub without vxProtocol is refused with exit 5 (skew)", func(t *testing.T) {
		hub := &vxHub{targets: `{"opId":"op1","targets":[],"maxArtifactBytes":268435456}`}
		srv := httptest.NewServer(hub.handler(t))
		defer srv.Close()
		(&volDocker{}).install(t)
		_, code, stderr := runVol(t, srv, "--arms", "all", "--dry-run")
		if code != exitSkew || !strings.Contains(stderr, "streamed volume copy") {
			t.Errorf("code=%d stderr=%s", code, stderr)
		}
	})
}

func TestVolumeFlagValidation(t *testing.T) {
	stubDockerOnPath(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	for _, args := range [][]string{
		{"--arms", "everything"}, {"--part-mib", "8"}, {"--part-mib", "9999"}, {"--stop-timeout", "0"}, {"--hub-outage-wait", "2h"},
		{"--speedtest-mib", "-1"}, {"--helper-image", "bad image;rm"}, {"--helper-image", "-x"},
	} {
		var stdout, stderr bytes.Buffer
		code := RunCLI(append([]string{"--hub", "https://hub.example"}, args...), "test", &stdout, &stderr)
		if code != exitUsage {
			t.Errorf("%v: exit=%d want %d", args, code, exitUsage)
		}
	}
}
