package migrate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// streamHub is a scripted hub for the whole volume arm: probe/recipes/targets, inventory, begin, the relay, finish, status.
type streamHub struct {
	*fakeRelayHub
	mu2          sync.Mutex
	targets      string
	beginStatus  int
	beginBody    string // overrides the begin answer
	finishStatus int
	finishBody   string
	statusSeq    []string // status states returned in order (last repeats)
	statusCalls  int32
	calls        []string
	begins       []VxBeginReq
	finishes     []VxFinishReq
	resets       int32
	aborts       int32
	manifest     []VxManifestEntry
	resumeFrom   int
	state        string
	speedEnds    int32
	speedCommits int
	speedFail    bool
	recipes      string // overrides the /recipes answer (the streamed dump lane needs real recipes)
	dbSizes      []dbSizeReq
}

func (s *streamHub) serve(t *testing.T) *httptest.Server {
	relay := s.fakeRelayHub.handler()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/api/v1/import/migration/")
		s.mu2.Lock()
		s.calls = append(s.calls, r.Method+" "+p)
		s.mu2.Unlock()
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v1/agent-vx/t/"):
			relay.ServeHTTP(w, r)
		case p == "probe":
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case p == "recipes":
			if s.recipes != "" {
				io.WriteString(w, s.recipes)
				return
			}
			io.WriteString(w, `{"v":1,"recipes":{},"unsupported":{}}`)
		case p == "targets":
			io.WriteString(w, s.targets)
		case p == "vx/db-sizes":
			b, _ := io.ReadAll(r.Body)
			var req dbSizeReq
			_ = json.Unmarshal(b, &req)
			s.mu2.Lock()
			s.dbSizes = append(s.dbSizes, req)
			s.mu2.Unlock()
			io.WriteString(w, `{"expiresAt":"2999-01-01T00:00:00Z"}`)
		case p == "vx/inventory":
			io.WriteString(w, `{"stored":1,"expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.HasSuffix(p, "/begin"):
			b, _ := io.ReadAll(r.Body)
			var req VxBeginReq
			_ = json.Unmarshal(b, &req)
			s.mu2.Lock()
			s.begins = append(s.begins, req)
			s.mu2.Unlock()
			if s.beginStatus != 0 {
				w.WriteHeader(s.beginStatus)
				io.WriteString(w, s.beginBody)
				return
			}
			man, _ := json.Marshal(s.manifest)
			st := s.state
			if st == "" {
				st = "COPYING"
			}
			fmt.Fprintf(w, `{"transferId":"cktr0000000000000000001","attempt":1,"state":%q,"partRawBytes":%d,"resumeFromPart":%d,"manifest":%s,"expiresAt":"2999-01-01T00:00:00Z"}`, st, req.PartRawBytes, s.resumeFrom, string(man))
		case strings.HasSuffix(p, "/finish"):
			b, _ := io.ReadAll(r.Body)
			var req VxFinishReq
			_ = json.Unmarshal(b, &req)
			s.mu2.Lock()
			s.finishes = append(s.finishes, req)
			s.mu2.Unlock()
			if s.finishStatus != 0 {
				w.WriteHeader(s.finishStatus)
				io.WriteString(w, s.finishBody)
				return
			}
			w.WriteHeader(202)
			io.WriteString(w, `{"state":"APPLYING","expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.HasSuffix(p, "/status"):
			n := int(atomic.AddInt32(&s.statusCalls, 1)) - 1
			seq := s.statusSeq
			if len(seq) == 0 {
				seq = []string{`{"state":"DONE"}`}
			}
			if n >= len(seq) {
				n = len(seq) - 1
			}
			io.WriteString(w, seq[n])
		case strings.HasSuffix(p, "/speedtest-end"):
			atomic.AddInt32(&s.speedEnds, 1)
			io.WriteString(w, `{"ok":true}`)
		case strings.Contains(p, "/speedtest/") && strings.HasSuffix(p, "/commit"):
			s.mu2.Lock()
			s.speedCommits++
			s.mu2.Unlock()
			if s.speedFail {
				io.WriteString(w, `{"done":false,"retryable":true,"reason":"target exit 22"}`)
				return
			}
			io.WriteString(w, `{"done":true,"bytes":1,"ms":10}`)
		case strings.Contains(p, "/speedtest/"):
			b, _ := io.ReadAll(r.Body)
			var req VxPartReq
			_ = json.Unmarshal(b, &req)
			i := strings.Index(p, "/speedtest/")
			idx, _ := strconv.Atoi(p[i+len("/speedtest/"):])
			s.fakeRelayHub.mu.Lock()
			s.fakeRelayHub.registered[idx] = req
			id := fmt.Sprintf("speedid%019d", len(s.fakeRelayHub.srcPaths)+1)
			s.fakeRelayHub.srcPaths[id] = idx
			s.fakeRelayHub.mu.Unlock()
			fmt.Fprintf(w, `{"srcPath":"/api/v1/agent-vx/t/%s?exp=1999999999&sig=%s"}`, id, strings.Repeat("s", 43))
		case strings.HasSuffix(p, "/reset"):
			atomic.AddInt32(&s.resets, 1)
			io.WriteString(w, `{"state":"PENDING","attempt":2}`)
		case strings.HasSuffix(p, "/abort"):
			atomic.AddInt32(&s.aborts, 1)
			io.WriteString(w, `{"state":"FAILED"}`)
		default:
			relay.ServeHTTP(w, r)
		}
	}))
}

func (s *streamHub) sawCall(sub string) bool {
	s.mu2.Lock()
	defer s.mu2.Unlock()
	for _, c := range s.calls {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

func appTargets() string { return volTargetsJSON() }

// runStream drives RunCLI for `--arms volumes` against the scripted hub with the fake docker and tar stream.
func runStream(t *testing.T, hub *streamHub, d *volDocker, stream []byte, args ...string) (output, int, string) {
	t.Helper()
	stubDockerOnPath(t)
	noSleep(t)
	srv := hub.serve(t)
	t.Cleanup(srv.Close)
	d.install(t)
	fakeTar(t, stream, nil)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	var stdout, stderr bytes.Buffer
	base := []string{"--hub", srv.URL, "--arms", "volumes", "--helper-image", "img:1", "--part-mib", "128"}
	code := RunCLI(append(base, args...), "test", &stdout, &stderr)
	var out output
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil {
		t.Fatalf("stdout is not one JSON line: %v\n%s\nstderr:%s", err, stdout.String(), stderr.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), "tugra_mig_aaaa") {
		t.Error("the token leaked")
	}
	return out, code, stderr.String()
}

func streamHubWith(t *testing.T, targets string) *streamHub {
	f := newFakeRelayHub(t)
	return &streamHub{fakeRelayHub: f, targets: targets}
}

const policyJSON = `"vxProtocol":1,"vx":{"partRawBytes":134217728,"maxBytes":274877906944,"maxParts":100000}`

func withPolicy(rows ...string) string {
	return `{"opId":"op1","targets":[` + strings.Join(rows, ",") + `],"maxArtifactBytes":268435456,` + policyJSON + `}`
}

const appRow = `{"itemRef":"volume:srv1:5f3a9c:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"app-volume","name":"data","mountPath":"/var/www/data"},"appItemRef":"app:srv1:5f3a9c"}`

func invFor(bytesN int) string {
	return fmt.Sprintf("TUGRA_INV bytes=%d entries=17 sockets=0 fifos=0 devices=0 pgv=- nested=-\n", bytesN)
}

func TestVolumeRunHappyPath(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	stream := streamBytes(3000)
	out, code, stderr := runStream(t, hub, d, stream)
	if code != exitOK {
		t.Fatalf("exit=%d out=%+v stderr=%s", code, out, stderr)
	}
	it := out.Items[0]
	if it.State != "volume-applied" || it.Parts != 1 || it.RawBytes != 3000 || out.Counts.Restored != 1 {
		t.Errorf("item: %+v counts=%+v", it, out.Counts)
	}
	// begin carried the fingerprint of the STOPPED container and the hub's part size
	b := hub.begins[0]
	if b.PartRawBytes != 134217728 || b.Fingerprint.ContainerID != appCtrID || b.Fingerprint.FinishedAt != "2026-11-14T10:00:00Z" || b.Fingerprint.MountName != "5f3a9c_data" || b.RawTotal == nil || *b.RawTotal != 3000 {
		t.Errorf("begin: %+v", b)
	}
	// finish carried the totals and the after-fingerprint (not running)
	fin := hub.finishes[0]
	if fin.Parts != 1 || fin.RawBytes != 3000 || fin.Entries != 17 || fin.FingerprintAfter.Running || fin.FingerprintAfter.ContainerID != appCtrID {
		t.Errorf("finish: %+v", fin)
	}
	if got := reassemble(t, hub.fakeRelayHub, 1); !bytes.Equal(got, stream) {
		t.Error("the relay received something other than the archive")
	}
	// nothing was stopped or started; the source stays as found
	if len(d.stopCalls) != 0 || len(d.startCalls) != 0 {
		t.Errorf("stop=%v start=%v", d.stopCalls, d.startCalls)
	}
	// order of hub calls: inventory, begin, part, commit, finish, status
	seq := strings.Join(hub.calls, "|")
	for _, want := range []string{"vx/inventory", "/begin", "/parts/0", "/commit", "/finish", "/status"} {
		if !strings.Contains(seq, want) {
			t.Errorf("missing call %q in %s", want, seq)
		}
	}
	if strings.Index(seq, "/begin") > strings.Index(seq, "/parts/0") || strings.Index(seq, "/finish") > strings.Index(seq, "/status") {
		t.Errorf("wrong order: %s", seq)
	}
}

func TestVolumeRunRefusesRunningSourceWithoutStopFlag(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	c := stoppedApp()
	c.running = true
	d := &volDocker{ctrs: []*vctr{c}, invOut: invFor(10)}
	out, code, _ := runStream(t, hub, d, streamBytes(10))
	if code != exitPartial || out.Items[0].State != "volume-skipped-running" || !strings.Contains(out.Items[0].Reason, "stop 5f3a9c-170000000000 first (or rerun with --stop-source)") {
		t.Errorf("code=%d %+v", code, out.Items)
	}
	if len(d.stopCalls) != 0 || hub.sawCall("/begin") || hub.sawCall("vx/inventory") {
		t.Error("a refused volume must not stop anything nor reach the hub")
	}
}

func TestVolumeRunStopSourceStopsOnlyThatContainerAndLeavesItStoppedAfterCopy(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	c := stoppedApp()
	c.running = true
	c.finish, c.started = "", "2026-11-15T08:00:00Z"
	other := &vctr{id: otherID, name: "unrelated", image: "x", running: true}
	d := &volDocker{ctrs: []*vctr{c, other}, invOut: invFor(3000), onStop: func(cc *vctr) { cc.finish = "2026-11-15T09:00:00Z"; cc.exit = 0 }}
	out, code, _ := runStream(t, hub, d, streamBytes(3000), "--stop-source", "--stop-timeout", "30")
	if code != exitOK || out.Items[0].State != "volume-applied" {
		t.Fatalf("code=%d %+v", code, out.Items)
	}
	if len(d.stopCalls) != 1 || d.stopCalls[0][len(d.stopCalls[0])-1] != appCtrID || !contains(d.stopCalls[0], "30") {
		t.Errorf("stop calls: %v", d.stopCalls)
	}
	for _, c := range d.stopCalls {
		if contains(c, "rm") {
			t.Error("never docker rm")
		}
	}
	if len(d.startCalls) != 0 {
		t.Errorf("after a completed copy the source stays stopped: %v", d.startCalls)
	}
	if hub.begins[0].Fingerprint.FinishedAt != "2026-11-15T09:00:00Z" {
		t.Errorf("the fingerprint must be taken AFTER the stop: %+v", hub.begins[0].Fingerprint)
	}
}

func TestVolumeRunRestartsAStoppedSourceWhenTheCopyFails(t *testing.T) {
	for name, mk := range map[string]func(h *streamHub){
		"begin refused": func(h *streamHub) {
			h.beginStatus, h.beginBody = 409, `{"message":"another migrator run is active for this volume"}`
		},
		"disk": func(h *streamHub) {
			h.beginStatus, h.beginBody = 409, `{"message":"vx-disk-insufficient: needs 70 GiB"}`
		},
		"part fails":     func(h *streamHub) { h.putFail = func(int, int) int { return 500 } },
		"finish refused": func(h *streamHub) { h.finishStatus, h.finishBody = 409, `{"message":"vx-fingerprint-changed"}` },
	} {
		hub := streamHubWith(t, withPolicy(appRow))
		mk(hub)
		c := stoppedApp()
		c.running = true
		d := &volDocker{ctrs: []*vctr{c}, invOut: invFor(3000)}
		out, code, _ := runStream(t, hub, d, streamBytes(3000), "--stop-source")
		if code != exitPartial || out.Items[0].State == "volume-applied" {
			t.Errorf("%s: code=%d %+v", name, code, out.Items)
		}
		if len(d.stopCalls) != 1 || len(d.startCalls) != 1 || d.startCalls[0][len(d.startCalls[0])-1] != appCtrID {
			t.Errorf("%s: a container this run stopped must be restarted on failure: stop=%v start=%v", name, d.stopCalls, d.startCalls)
		}
	}
}

func TestVolumeRunNeverStartsAContainerItDidNotStop(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	hub.beginStatus, hub.beginBody = 409, `{"message":"vx-diverged"}`
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)} // already stopped by the operator
	out, _, _ := runStream(t, hub, d, streamBytes(3000))
	if out.Items[0].State != "volume-diverged" || len(d.startCalls) != 0 || len(d.stopCalls) != 0 {
		t.Errorf("%+v start=%v stop=%v", out.Items[0], d.startCalls, d.stopCalls)
	}
}

func TestVolumeRunRestartOnFailureCanBeDisabled(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	hub.beginStatus, hub.beginBody = 409, `{"message":"vx-disk-insufficient"}`
	c := stoppedApp()
	c.running = true
	d := &volDocker{ctrs: []*vctr{c}, invOut: invFor(3000)}
	runStream(t, hub, d, streamBytes(3000), "--stop-source", "--restart-on-failure=false")
	if len(d.startCalls) != 0 {
		t.Error("--restart-on-failure=false must leave it stopped")
	}
}

func TestVolumeRunStopFailureIsReportedAndNothingElseHappens(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	c := stoppedApp()
	c.running = true
	d := &volDocker{ctrs: []*vctr{c}, invOut: invFor(3000), stopErr: fmt.Errorf("exit 1")}
	out, _, _ := runStream(t, hub, d, streamBytes(3000), "--stop-source")
	if out.Items[0].State != "failed" || out.Items[0].Reason != "stop-failed" || hub.sawCall("/begin") {
		t.Errorf("%+v", out.Items[0])
	}
}

func TestVolumeRunProvesQuiescenceAfterTheStop(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	c := stoppedApp()
	c.running = true
	d := &volDocker{ctrs: []*vctr{c}, invOut: invFor(3000), users: map[string][]string{"5f3a9c_data": {thirdID}}} // ANOTHER container uses the volume
	out, _, _ := runStream(t, hub, d, streamBytes(3000), "--stop-source")
	if out.Items[0].State != "volume-skipped-running" || hub.sawCall("/begin") {
		t.Errorf("another container on the volume: %+v", out.Items[0])
	}
	if len(d.startCalls) != 1 {
		t.Error("the container this run stopped is restarted when the copy cannot proceed")
	}
}

func TestVolumeRunSourceRestartedAfterTheLastByte(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	// the container starts running again while the stream is read
	orig := startTarFn
	runStreamSetup := func() {
		startTarFn = func(ctx context.Context, argv []string, env []string) (io.ReadCloser, func() error, error) {
			d.mu.Lock()
			d.ctrs[0].running = true
			d.mu.Unlock()
			return io.NopCloser(bytes.NewReader(streamBytes(3000))), func() error { return nil }, nil
		}
	}
	stubDockerOnPath(t)
	noSleep(t)
	srv := hub.serve(t)
	defer srv.Close()
	d.install(t)
	runStreamSetup()
	t.Cleanup(func() { startTarFn = orig })
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	var stdout, stderr bytes.Buffer
	RunCLI([]string{"--hub", srv.URL, "--arms", "volumes", "--helper-image", "img:1"}, "test", &stdout, &stderr)
	var out output
	_ = json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out)
	if out.Items[0].State != "volume-diverged" || out.Items[0].Reason != "source-restarted" || len(hub.finishes) != 0 {
		t.Errorf("a source that came back must never be finished: %+v finishes=%d", out.Items[0], len(hub.finishes))
	}
}

func TestVolumeRunBeginConflictMapping(t *testing.T) {
	cases := []struct {
		status int
		msg    string
		state  string
		reason string
	}{
		{409, "vx-fingerprint-changed", "volume-diverged", "fingerprint-changed: rerun with --reset-volume volume:srv1:5f3a9c:data"},
		{409, "vx-diverged", "volume-diverged", "diverged: rerun with --reset-volume volume:srv1:5f3a9c:data"},
		{409, "vx-aborted", "volume-aborted", "owner-aborted"},
		{409, "vx-disk-insufficient: the transfer needs about 11.2 GiB free", "volume-disk-insufficient", "target-disk: vx-disk-insufficient: the transfer needs about 11.2 GiB free"},
		{413, "too big", "volume-disk-insufficient", "over-limit"},
		{409, "another migrator run is active for this volume", "failed", "another-run-active"},
		{409, "the destination was started or holds data not restored by this migration", "failed", "dest-dirty"},
		{409, "this volume already uses the hub-staged upload", "failed", "uses-hub-staged-upload"},
		{409, "PostgreSQL 18 data layout is not supported by Tugra database volumes yet", "failed", "refused: PostgreSQL 18 data layout is not supported by Tugra database volumes yet"},
		{404, "no such migration target", "failed", "no-such-target"},
	}
	for _, c := range cases {
		hub := streamHubWith(t, withPolicy(appRow))
		hub.beginStatus, hub.beginBody = c.status, fmt.Sprintf(`{"message":%q}`, c.msg)
		d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
		out, _, _ := runStream(t, hub, d, streamBytes(3000))
		if got := out.Items[0]; got.State != c.state || got.Reason != c.reason {
			t.Errorf("%q: state=%q reason=%q", c.msg, got.State, got.Reason)
		}
	}
}

func TestVolumeRunAuthLossAbortsTheRun(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	hub.beginStatus, hub.beginBody = 401, `{"message":"nope"}`
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	_, code, _ := runStream(t, hub, d, streamBytes(3000))
	if code != exitAuth {
		t.Errorf("exit=%d want %d", code, exitAuth)
	}
}

func TestVolumeRunAlreadyAppliedAndApplyingStates(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	hub.beginStatus = 200
	hub.beginBody = `{"transferId":"cktr0000000000000000001","attempt":1,"state":"DONE","alreadyDone":true,"partRawBytes":134217728,"resumeFromPart":3,"manifest":[],"expiresAt":"2999-01-01T00:00:00Z"}`
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	out, code, _ := runStream(t, hub, d, streamBytes(3000))
	if code != exitOK || out.Items[0].State != "volume-applied" || out.Items[0].Reason != "already-applied" || out.Counts.Restored != 1 || len(hub.putBodies) != 0 {
		t.Errorf("code=%d %+v", code, out.Items[0])
	}
	// an apply that already started: no tar, no parts, just poll
	hub2 := streamHubWith(t, withPolicy(appRow))
	hub2.state = "APPLYING"
	d2 := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	out2, _, _ := runStream(t, hub2, d2, streamBytes(3000))
	if out2.Items[0].State != "volume-applied" || len(hub2.putBodies) != 0 || len(hub2.finishes) != 0 {
		t.Errorf("%+v", out2.Items[0])
	}
}

func TestVolumeRunApplyPollOutcomes(t *testing.T) {
	cases := []struct {
		seq    []string
		state  string
		reason string
	}{
		{[]string{`{"state":"APPLYING"}`, `{"state":"APPLYING"}`, `{"state":"DONE"}`}, "volume-applied", ""},
		{[]string{`{"state":"FAILED","error":"extracting failed and the destination volume was rolled back"}`}, "volume-copied", "apply-failed: extracting failed and the destination volume was rolled back"},
		{[]string{`{"state":"ABORTED"}`}, "volume-aborted", "owner-aborted"},
	}
	for _, c := range cases {
		hub := streamHubWith(t, withPolicy(appRow))
		hub.statusSeq = c.seq
		d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
		out, code, _ := runStream(t, hub, d, streamBytes(3000))
		if out.Items[0].State != c.state || out.Items[0].Reason != c.reason {
			t.Errorf("%v: state=%q reason=%q", c.seq, out.Items[0].State, out.Items[0].Reason)
		}
		wantCode := exitPartial
		if c.state == "volume-applied" {
			wantCode = exitOK
		}
		if code != wantCode {
			t.Errorf("%v: exit=%d want %d", c.seq, code, wantCode)
		}
	}
}

func TestVolumeRunResumeSkipsCommittedPartsAndResetsOnRequest(t *testing.T) {
	stream := streamBytes(3000)
	// resume: the hub already holds part 0 of a 1000-byte-part policy
	hub := streamHubWith(t, `{"opId":"op1","targets":[`+appRow+`],"maxArtifactBytes":1,"vxProtocol":1,"vx":{"partRawBytes":33554432,"maxBytes":274877906944,"maxParts":100000}}`)
	_ = hub
	// the CLI enforces the hub's 128 MiB policy in production; resume mechanics are covered at the StreamVolume level
	// (TestStreamVolumeResumeComparesRawHashesAndSendsNothingCommitted). Here: a reset request reaches the hub BEFORE begin.
	hub2 := streamHubWith(t, withPolicy(appRow))
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	out, _, _ := runStream(t, hub2, d, stream, "--reset-volume", "volume:srv1:5f3a9c:data")
	if atomic.LoadInt32(&hub2.resets) != 1 || out.Items[0].State != "volume-applied" {
		t.Errorf("resets=%d %+v", hub2.resets, out.Items[0])
	}
	seq := strings.Join(hub2.calls, "|")
	if strings.Index(seq, "/reset") > strings.Index(seq, "/begin") {
		t.Errorf("reset must precede begin: %s", seq)
	}
}

func TestVolumeRunPartMiBMustEqualTheHubPolicy(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	out, _, _ := runStream(t, hub, d, streamBytes(3000), "--part-mib", "64")
	// runStream passes --part-mib 128 first; the later flag wins in the flag package
	if out.Items[0].State != "failed" || out.Items[0].Reason != "part-size" || hub.sawCall("/begin") {
		t.Errorf("%+v", out.Items[0])
	}
}

func TestVolumeRunExcludedVolumeIsReportedNotMigratedNeverSilently(t *testing.T) {
	excl := `{"itemRef":"volume:srv1:clk:data","kind":"volume","volumeIngest":"excluded","reason":"58 GB ClickHouse excluded by the owner","dest":{"type":"app-volume","name":"data","mountPath":"/x"},"appItemRef":"app:srv1:clk"}`
	hub := streamHubWith(t, withPolicy(excl))
	d := &volDocker{invOut: invFor(1)}
	out, code, _ := runStream(t, hub, d, nil)
	if code != exitPartial || out.Items[0].State != "volume-not-migrated" || !strings.Contains(out.Items[0].Reason, "58 GB ClickHouse") || out.Counts.Skipped != 1 || hub.sawCall("/begin") {
		t.Errorf("code=%d %+v", code, out.Items[0])
	}
}

func TestVolumeRunPostgresGatesComeFromTheHubText(t *testing.T) {
	row := `{"itemRef":"volume:srv1:pg7c1:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"db-data","name":"data","mountPath":"/var/lib/postgresql/data"},"databaseItemRef":"database:srv1:pg7c1","engine":"POSTGRES","engineVersion":"16","sourceImage":"postgres:16-alpine"}`
	hub := streamHubWith(t, withPolicy(row))
	hub.beginStatus, hub.beginBody = 409, `{"message":"this database's credentials were not carried from the source, so a copied data directory would not match them; use the logical dump"}`
	pg := &vctr{id: dbCtrID, name: "pg7c1", image: "postgres:16-alpine", exit: 137, mounts: []dockerMount{{Type: "volume", Name: "pg_data", Destination: "/var/lib/postgresql/data"}}}
	d := &volDocker{ctrs: []*vctr{pg}, invOut: "TUGRA_INV bytes=100 entries=9 sockets=0 fifos=0 devices=0 pgv=16 nested=-\n"}
	out, _, _ := runStream(t, hub, d, streamBytes(100))
	if out.Items[0].State != "failed" || !strings.HasPrefix(out.Items[0].Reason, "refused: this database's credentials were not carried") {
		t.Errorf("%+v", out.Items[0])
	}
	if hub.begins[0].Fingerprint.PgMajor != "16" || out.Items[0].Engine != "POSTGRES" {
		t.Errorf("the postgres major rides the fingerprint: %+v", hub.begins[0].Fingerprint)
	}
}

func TestVolumeRunTokenMargin(t *testing.T) {
	second := strings.ReplaceAll(appRow, "5f3a9c", "bbbbbb")
	hub := streamHubWith(t, withPolicy(appRow, second))
	// the first volume's final status carries a token with 60 s left: the second volume must not start
	hub.statusSeq = []string{`{"state":"DONE","expiresAt":"` + nowPlus(60) + `"}`}
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(3000)}
	out, code, _ := runStream(t, hub, d, streamBytes(3000))
	if len(out.Items) != 2 || out.Items[0].State != "volume-applied" || out.Items[1].State != "volume-aborted" || out.Items[1].Reason != "token-expiring" {
		t.Fatalf("items: %+v", out.Items)
	}
	if code != exitPartial {
		t.Errorf("exit=%d", code)
	}
	if hub.sawCall("bbbbbb") {
		t.Error("an expiring token must not start another volume")
	}
}

func nowPlus(sec int) string {
	return time.Now().Add(time.Duration(sec) * time.Second).UTC().Format(time.RFC3339)
}

func TestSpeedtestMeasuresTheRealLinkAndThrowsTheBytesAway(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(10 * 1024 * 1024)}
	// the 'volume' is 10 MiB; ask for 4 MiB: exactly 4 MiB must cross the relay
	out, code, stderr := runStream(t, hub, d, streamBytes(10*1024*1024), "--dry-run", "--speedtest-mib", "4")
	if code != exitOK {
		t.Fatalf("exit=%d %+v %s", code, out, stderr)
	}
	it := out.Items[0]
	if it.State != "planned" || it.Reason != "speedtest" || it.SpeedMBps <= 0 || it.EstimateSeconds < 15*60 {
		t.Errorf("item: %+v", it)
	}
	var got int
	for _, bodies := range hub.putBodies {
		for _, b := range bodies {
			zr := mustGzip(t, b)
			dec, _ := io.ReadAll(zr)
			got += len(dec)
		}
	}
	if got != 4*1024*1024 {
		t.Errorf("the relay should carry exactly the requested first 4 MiB, got %d", got)
	}
	if atomic.LoadInt32(&hub.speedEnds) != 1 {
		t.Errorf("the throwaway staging must be removed (speedtest-end called %d times)", hub.speedEnds)
	}
	for _, c := range []string{"/begin", "/finish", "/parts/"} {
		if hub.sawCall(c) {
			t.Errorf("a speed test is not a copy: %s was called", c)
		}
	}
	if len(d.stopCalls) != 0 {
		t.Error("a speed test never stops anything")
	}
}

func TestSpeedtestFailureIsReportedNotFatalAndStillCleansUp(t *testing.T) {
	hub := streamHubWith(t, withPolicy(appRow))
	hub.speedFail = true
	d := &volDocker{ctrs: []*vctr{stoppedApp()}, invOut: invFor(1024 * 1024)}
	out, code, _ := runStream(t, hub, d, streamBytes(1024*1024), "--speedtest-mib", "1")
	if code != exitOK || out.Items[0].Reason != "speedtest-failed" || out.Items[0].SpeedMBps != 0 {
		t.Errorf("code=%d %+v", code, out.Items[0])
	}
	if atomic.LoadInt32(&hub.speedEnds) != 1 {
		t.Error("cleanup must run after a failed test too")
	}
}

func TestSpeedtestMiBBounds(t *testing.T) {
	stubDockerOnPath(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	for _, v := range []string{"-1", "1025"} {
		var stdout, stderr bytes.Buffer
		if code := RunCLI([]string{"--hub", "https://hub.example", "--speedtest-mib", v}, "test", &stdout, &stderr); code != exitUsage {
			t.Errorf("%s: exit=%d", v, code)
		}
	}
}
