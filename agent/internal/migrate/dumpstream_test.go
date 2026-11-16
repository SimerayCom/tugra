package migrate

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---- the size statements and their parsing ----------------------------------------------------------------------------

func TestBuildSizePlanGoldens(t *testing.T) {
	env := func(k string) (string, bool) {
		if k == "PATH" {
			return "/usr/bin", true
		}
		return "", false
	}
	c := Creds{Ctr: pgID, User: "app", DB: "appdb", PW: "s3cret", HasPW: true}
	p, err := buildSizePlan("POSTGRES", c, "/usr/bin/docker", env)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/usr/bin/docker", "exec", "-e", "PGPASSWORD", pgID, "psql", "-X", "-q", "-A", "-t", "-U", "app", "-d", "appdb", "-c", "SELECT pg_database_size(current_database())"}
	if strings.Join(p.Argv, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("argv: %v", p.Argv)
	}
	for _, a := range p.Argv {
		if strings.Contains(a, "s3cret") {
			t.Error("the password must never be on an argv")
		}
	}
	if !contains(p.Env, "PGPASSWORD=s3cret") || !contains(p.Env, "PATH=/usr/bin") || len(p.Env) != 2 {
		t.Errorf("env must be the allowlist plus the one bound secret: %v", p.Env)
	}
	m, err := buildSizePlan("MARIADB", c, "/usr/bin/docker", env)
	if err != nil || m.Argv[5] != "sh" || !strings.Contains(m.Argv[7], `mariadb -u"$1"`) || m.Argv[8] != "tugra-size" || m.Argv[9] != "app" || !contains(m.Env, "MYSQL_PWD=s3cret") {
		t.Errorf("mariadb plan: %v %v", m.Argv, err)
	}
	if strings.Contains(m.Argv[7], "appdb") {
		t.Error("the user and database travel as positional parameters, never spliced into the script")
	}
	for _, bad := range []Creds{{Ctr: "x y", User: "a", DB: "b"}, {Ctr: pgID, User: "-a", DB: "b"}, {Ctr: pgID, User: "a", DB: "b;c"}} {
		if _, err := buildSizePlan("POSTGRES", bad, "docker", env); err == nil {
			t.Errorf("%+v must be refused", bad)
		}
	}
	if _, err := buildSizePlan("REDIS", c, "docker", env); err == nil {
		t.Error("an engine with no dump lane has no size statement")
	}
}

func TestParseSizeOutput(t *testing.T) {
	for in, want := range map[string]int64{"123\n": 123, " 0 ": 0, "\n9007199254740991\r\n": 9007199254740991} {
		if n, err := parseSizeOutput(in); err != nil || n != want {
			t.Errorf("%q -> %d %v", in, n, err)
		}
	}
	for _, bad := range []string{"", "x", "-1", "1\n2", "1.5", "12 MB"} {
		if _, err := parseSizeOutput(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

// ---- StreamDump ---------------------------------------------------------------------------------------------------------

// fakeDump installs a startDumpFn that serves `stream`, then exits with `exit`; it records the plan it was given.
func fakeDump(t *testing.T, stream []byte, exit error) *Plan {
	t.Helper()
	seen := &Plan{}
	orig := startDumpFn
	t.Cleanup(func() { startDumpFn = orig })
	startDumpFn = func(ctx context.Context, p Plan) (io.ReadCloser, func() error, error) {
		*seen = p
		return io.NopCloser(bytes.NewReader(stream)), func() error { return exit }, nil
	}
	return seen
}

func pgDump(n int) []byte {
	b := streamBytes(n)
	copy(b, "PGDMP")
	return b
}

var testPlan = Plan{Argv: []string{"docker", "exec", "x"}, Env: []string{"PATH=/usr/bin"}, Engine: "POSTGRES", Container: pgID}

func TestStreamDumpDeliversEveryPartAndTheMembersDecodeToTheDump(t *testing.T) {
	noSleep(t)
	for _, size := range []int{20, 999, 1000, 1001, 2500, 3001} {
		stream := pgDump(size)
		fakeDump(t, stream, nil)
		f := newFakeRelayHub(t)
		h := newStreamHub(t, f)
		res, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12", BeatEvery: time.Hour})
		if err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		wantParts := (size + 999) / 1000
		if res.Parts != wantParts || res.RawBytes != int64(size) {
			t.Errorf("size %d: parts=%d raw=%d", size, res.Parts, res.RawBytes)
		}
		if got := reassemble(t, f, wantParts); !bytes.Equal(got, stream) {
			t.Errorf("size %d: decoded stream differs from the dump", size)
		}
	}
}

func TestStreamDumpAlwaysStartsAtPartZero(t *testing.T) {
	noSleep(t)
	stream := pgDump(2500)
	fakeDump(t, stream, nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	// a resume point and a manifest are ignored: a dump is not byte-deterministic, so a committed prefix cannot be compared
	_, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12", ResumeFromPart: 2, Manifest: []VxManifestEntry{{Idx: 0}}, BeatEvery: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if len(f.putBodies[0]) != 1 || f.registered[0].RawOffset != 0 {
		t.Errorf("part 0 must be sent: %v", f.registered)
	}
}

func TestStreamDumpRefusesAWrongHeaderBeforeAnythingIsCommitted(t *testing.T) {
	noSleep(t)
	garbage := streamBytes(3000)
	garbage[0] = 'X'
	fakeDump(t, garbage, nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	_, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12", BeatEvery: time.Hour})
	if !errors.Is(err, ErrDumpStream) {
		t.Fatalf("a dump that is not the expected archive must fail as a dump failure: %v", err)
	}
	if len(f.putBodies) != 0 {
		t.Error("nothing may be delivered from a stream that failed its format check")
	}
}

func TestStreamDumpNeverAcceptsAFailedExit(t *testing.T) {
	noSleep(t)
	fakeDump(t, pgDump(1500), fmt.Errorf("%w (exit 1)", ErrDumpStream))
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	if _, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12", BeatEvery: time.Hour}); !errors.Is(err, ErrDumpStream) {
		t.Errorf("a dump that exits non-zero is never accepted, whatever it streamed: %v", err)
	}
	fakeDump(t, nil, nil)
	if _, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12", BeatEvery: time.Hour}); !errors.Is(err, ErrDumpStream) {
		t.Errorf("an empty dump is never accepted: %v", err)
	}
}

func TestStreamDumpHubOutageIsWaitedOutWithTheSameBuffer(t *testing.T) {
	noSleep(t)
	stream := pgDump(2200)
	fakeDump(t, stream, nil)
	f := newFakeRelayHub(t)
	f.putFail = func(idx, attempt int) int {
		if idx == 1 && attempt == 1 {
			return 502 // the hub restarted mid-part
		}
		return 0
	}
	h := newStreamHub(t, f)
	h.SetOutageWait(time.Minute)
	if _, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12", BeatEvery: time.Hour}); err != nil {
		t.Fatal(err)
	}
	if got := reassemble(t, f, 3); !bytes.Equal(got, stream) {
		t.Error("the retried dump differs from the source")
	}
	if f.putAttempt[1] != 2 {
		t.Errorf("part 1 must have been re-sent once: %d attempts", f.putAttempt[1])
	}
}

func TestStreamDumpKeepsTheLeaseAliveWhileTheProducerIsSlow(t *testing.T) {
	// the producer blocks (a dump that has not produced output yet); the lease beat must fire meanwhile
	noSleep(t)
	orig := startDumpFn
	t.Cleanup(func() { startDumpFn = orig })
	release := make(chan struct{})
	startDumpFn = func(ctx context.Context, p Plan) (io.ReadCloser, func() error, error) {
		pr, pw := io.Pipe()
		go func() {
			<-release
			_, _ = pw.Write(pgDump(10))
			_ = pw.Close()
		}()
		return pr, func() error { return nil }, nil
	}
	var beats int32
	f := newFakeRelayHub(t)
	inner := f.handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/beat") {
			if atomic.AddInt32(&beats, 1) == 1 {
				close(release)
			}
			io.WriteString(w, `{"expiresAt":"2999-01-01T00:00:00Z"}`)
			return
		}
		inner.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	h := newTestHub(t, srv)
	done := make(chan error, 1)
	go func() {
		_, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12", BeatEvery: 20 * time.Millisecond})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the dump never finished: the beat did not fire")
	}
	if atomic.LoadInt32(&beats) == 0 {
		t.Error("no lease beat while the dump produced nothing")
	}
}

func TestMeasureDumpCountsRawAndGzipBytesWithoutKeepingAnything(t *testing.T) {
	stream := pgDump(50_000)
	fakeDump(t, stream, nil)
	ds, err := MeasureDump(context.Background(), testPlan, time.Minute)
	if err != nil || ds.RawBytes != 50_000 {
		t.Fatalf("%+v %v", ds, err)
	}
	var gz bytes.Buffer
	w, _ := gzip.NewWriterLevel(&gz, gzip.BestSpeed)
	_, _ = w.Write(stream)
	_ = w.Close()
	if ds.GzBytes != int64(gz.Len()) {
		t.Errorf("the gzip size must be what the artifact route would carry (same level): %d vs %d", ds.GzBytes, gz.Len())
	}
	fakeDump(t, stream, errors.New("exit 1"))
	if _, err := MeasureDump(context.Background(), testPlan, time.Minute); err == nil {
		t.Error("a failed dump is not a measurement")
	}
	bad := pgDump(100)
	bad[1] = 'X'
	fakeDump(t, bad, nil)
	if _, err := MeasureDump(context.Background(), testPlan, time.Minute); err == nil {
		t.Error("a dump with the wrong header is not a measurement")
	}
}

// ---- the whole CLI: size measurement and the streamed dump -------------------------------------------------------------

const (
	dumpDbRow   = `{"itemRef":"database:srv1:pg1","kind":"database","engine":"POSTGRES","dataPlane":"volume"}`
	dumpVolRow  = `{"itemRef":"volume:srv1:pg1:dump","kind":"volume","volumeIngest":"stream-dump","dest":{"type":"db-dump","name":"dump","mountPath":""},"databaseItemRef":"database:srv1:pg1","engine":"POSTGRES","engineVersion":"16","sourceImage":"postgres:16-alpine"}`
	dumpStarted = "2026-11-10T00:00:00Z"
)

// dumpDocker stubs runDocker for the dump lane: ps, inspect (with the daemon's timestamps) and the size statement.
type dumpDocker struct {
	mu       sync.Mutex
	running  bool
	started  []string // StartedAt answers in order (the last repeats): a changing value is a restarted source
	inspects int
	sizeOut  string
	sizeErr  error
	calls    [][]string
}

func (d *dumpDocker) install(t *testing.T) {
	t.Helper()
	orig := runDocker
	t.Cleanup(func() { runDocker = orig })
	runDocker = func(ctx context.Context, argv []string, env []string) ([]byte, string, error) {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.calls = append(d.calls, append([]string{}, argv...))
		switch argv[1] {
		case "ps":
			if contains(argv, "--filter") { // the stale-helper reaper lists by label: real docker returns none of OUR database
				return nil, "", nil
			}
			return []byte(pgID + "\tpg1\n"), "", nil
		case "inspect":
			i := d.inspects
			d.inspects++
			if i >= len(d.started) {
				i = len(d.started) - 1
			}
			j := fmt.Sprintf(`{"Id":%q,"Name":"/pg1","Image":"sha256:deadbeef","State":{"Running":%v,"StartedAt":%q,"FinishedAt":"0001-01-01T00:00:00Z"},"Config":{"Image":"postgres:16-alpine","Env":["POSTGRES_USER=app","POSTGRES_PASSWORD=pw","POSTGRES_DB=appdb"],"Labels":{}}}`, pgID, d.running, d.started[i])
			return []byte(j), "", nil
		case "exec":
			if d.sizeErr != nil {
				return nil, "boom", d.sizeErr
			}
			return []byte(d.sizeOut), "", nil
		}
		return nil, "", fmt.Errorf("unexpected argv %v", argv)
	}
}

func (d *dumpDocker) saw(word string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, c := range d.calls {
		if contains(c, word) {
			return true
		}
	}
	return false
}

func pgRecipes() string {
	spec := engineSpecs["POSTGRES"]
	return `{"v":1,"recipes":{"POSTGRES":{"command":` + jsonStr(spec.golden) + `,"format":"pg_custom","pgFormat":"custom","env":[{"name":"PGPASSWORD","from":"pw"}]}},"unsupported":{}}`
}

func runDumpCLI(t *testing.T, hub *streamHub, d *dumpDocker, args ...string) (output, int, string) {
	t.Helper()
	stubDockerOnPath(t)
	noSleep(t)
	srv := hub.serve(t)
	t.Cleanup(srv.Close)
	d.install(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	var stdout, stderr bytes.Buffer
	base := []string{"--hub", srv.URL, "--helper-image", "img:1", "--part-mib", "128"}
	code := RunCLI(append(base, args...), "test", &stdout, &stderr)
	var out output
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil {
		t.Fatalf("stdout is not one JSON line: %v\n%s\nstderr:%s", err, stdout.String(), stderr.String())
	}
	for _, leak := range []string{"tugra_mig_aaaa", "PGPASSWORD=pw", "POSTGRES_PASSWORD"} {
		if strings.Contains(stdout.String()+stderr.String(), leak) {
			t.Errorf("a secret leaked: %q", leak)
		}
	}
	return out, code, stderr.String()
}

func dumpHub(t *testing.T) *streamHub {
	h := streamHubWith(t, withPolicy(dumpDbRow, dumpVolRow))
	h.recipes = pgRecipes()
	return h
}

func TestDumpRunHappyPathStreamsTheDumpAndNeverStopsAnything(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	stream := pgDump(3000)
	plan := fakeDump(t, stream, nil)
	out, code, stderr := runDumpCLI(t, hub, d, "--arms", "all")
	if code != exitOK {
		t.Fatalf("exit=%d out=%+v stderr=%s", code, out, stderr)
	}
	if len(out.Items) != 1 {
		t.Fatalf("the database row is moved by the dump row only (never dumped twice): %+v", out.Items)
	}
	it := out.Items[0]
	if it.ItemRef != "volume:srv1:pg1:dump" || it.Engine != "POSTGRES" || it.State != "volume-applied" || it.Parts != 1 || it.RawBytes != 3000 {
		t.Errorf("item: %+v", it)
	}
	if got := reassemble(t, hub.fakeRelayHub, 1); !bytes.Equal(got, stream) {
		t.Error("the relay received something other than the dump")
	}
	b := hub.begins[0]
	if b.Fingerprint.ContainerID != pgID || b.Fingerprint.StartedAt != dumpStarted || b.PartRawBytes != 134217728 {
		t.Errorf("begin: %+v", b)
	}
	fin := hub.finishes[0]
	if fin.Parts != 1 || fin.RawBytes != 3000 || fin.Entries != 0 || !fin.FingerprintAfter.Running || fin.FingerprintAfter.ContainerID != pgID || fin.FingerprintAfter.StartedAt != dumpStarted {
		t.Errorf("finish: %+v", fin)
	}
	// the pinned pg_dump, no shell, the password only as a bound env
	if strings.Join(plan.Argv[1:], " ") != "exec -e PGPASSWORD "+pgID+" pg_dump -Fc -Z0 --no-owner --no-acl -U app appdb" {
		t.Errorf("dump argv: %v", plan.Argv)
	}
	if !contains(plan.Env, "PGPASSWORD=pw") {
		t.Error("the dump child must carry the bound password")
	}
	for _, c := range d.calls {
		if contains(c, "stop") || contains(c, "start") || contains(c, "rm") || contains(c, "kill") {
			t.Errorf("a dump never stops, starts or removes anything: %v", c)
		}
	}
	if hub.sawCall("artifacts/") {
		t.Error("the artifact (cap-limited) route must never be used for a streamed dump")
	}
}

func TestDumpRunAFailedDumpIsNeverFinished(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	fakeDump(t, pgDump(3000), fmt.Errorf("%w (exit 1)", ErrDumpStream))
	out, code, _ := runDumpCLI(t, hub, d, "--arms", "all")
	if code != exitPartial || out.Items[0].State != "failed" || !strings.HasPrefix(out.Items[0].Reason, "dump-failed") {
		t.Errorf("code=%d %+v", code, out.Items)
	}
	if len(hub.finishes) != 0 {
		t.Error("a dump that failed must never be finished")
	}
}

func TestDumpRunRefusesASourceThatIsNotRunning(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: false, started: []string{dumpStarted}}
	fakeDump(t, pgDump(10), nil)
	out, _, _ := runDumpCLI(t, hub, d, "--arms", "all")
	if out.Items[0].State != "failed" || out.Items[0].Reason != "source-not-running" || hub.sawCall("/begin") {
		t.Errorf("%+v", out.Items[0])
	}
}

func TestDumpRunARestartedSourceIsDivergedNotFinished(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted, "2026-11-16T00:00:00Z"}}
	fakeDump(t, pgDump(3000), nil)
	out, code, _ := runDumpCLI(t, hub, d, "--arms", "all")
	if code != exitPartial || out.Items[0].State != "volume-diverged" || out.Items[0].Reason != "source-restarted" || len(hub.finishes) != 0 {
		t.Errorf("code=%d %+v finishes=%d", code, out.Items, len(hub.finishes))
	}
}

func TestDumpRunAHubThatOffersAResumePointIsNotTrusted(t *testing.T) {
	hub := dumpHub(t)
	hub.resumeFrom = 2
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	fakeDump(t, pgDump(3000), nil)
	out, _, _ := runDumpCLI(t, hub, d, "--arms", "all")
	if out.Items[0].State != "failed" || out.Items[0].Reason != "bad-response" || hub.sawCall("/parts/") {
		t.Errorf("%+v", out.Items[0])
	}
}

func TestDumpRunAnApplyingTransferOnlyPollsTheRestore(t *testing.T) {
	// every part is staged and the apply (a re-apply after a failed restore) is running: the migrator must not dump again
	hub := dumpHub(t)
	hub.state = "APPLYING"
	hub.statusSeq = []string{`{"state":"APPLYING"}`, `{"state":"DONE"}`}
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	fakeDump(t, pgDump(3000), nil)
	out, code, _ := runDumpCLI(t, hub, d, "--arms", "all")
	if code != exitOK || out.Items[0].State != "volume-applied" || hub.sawCall("/parts/") || len(hub.finishes) != 0 {
		t.Errorf("code=%d %+v", code, out.Items)
	}
}

func TestDumpRunAFailedRestoreIsReportedAsCopiedNotApplied(t *testing.T) {
	hub := dumpHub(t)
	hub.statusSeq = []string{`{"state":"FAILED","error":"pg_restore: error: could not execute query"}`}
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	fakeDump(t, pgDump(3000), nil)
	out, code, _ := runDumpCLI(t, hub, d, "--arms", "all")
	if code != exitPartial || out.Items[0].State != "volume-copied" || !strings.HasPrefix(out.Items[0].Reason, "apply-failed") {
		t.Errorf("code=%d %+v", code, out.Items)
	}
}

func TestDumpRowsWithAnUnknownIngestAreIgnored(t *testing.T) {
	// a row with a volumeIngest this binary does not know is never selected; one it knows is
	rows := []Target{{Kind: "volume", VolumeIngest: "stream-dump-v9", ItemRef: "volume:s:a:dump"}, {Kind: "volume", VolumeIngest: volumeIngestDump, ItemRef: "volume:s:b:dump"}}
	got := selectVolumeTargets(rows, nil)
	if len(got) != 1 || got[0].ItemRef != "volume:s:b:dump" {
		t.Errorf("%+v", got)
	}
}

func TestDryRunMeasuresEveryDumpCapableDatabaseOnlyWhenAsked(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted}, sizeOut: "34100000000\n"}
	fakeDump(t, pgDump(5000), nil)
	out, code, stderr := runDumpCLI(t, hub, d, "--arms", "all", "--dry-run", "--measure-dbs")
	if code != exitOK {
		t.Fatalf("code=%d %+v %s", code, out.Items, stderr)
	}
	if len(hub.dbSizes) != 1 || len(hub.dbSizes[0].Items) != 1 {
		t.Fatalf("the measurement must reach the hub: %+v", hub.dbSizes)
	}
	m := hub.dbSizes[0].Items[0]
	if m.ItemRef != "database:srv1:pg1" || m.Engine != "POSTGRES" || m.State != "measured" || m.DbBytes != 34100000000 {
		t.Errorf("measurement: %+v", m)
	}
	// 34 GB is over the cheap-dump threshold: the catalog size stands and the dump is NOT run to count it
	if m.MeasuredBy != "catalog" || m.DumpRawBytes != nil || m.DumpGzBytes != nil {
		t.Errorf("a database over --measure-dump-below is reported by catalog size only: %+v", m)
	}
	if len(out.DbSizes) != 1 {
		t.Errorf("the run's JSON must carry the measurements: %+v", out.DbSizes)
	}
	// the dump row's plan: would stream, sized from the catalog, the target disk asked about it
	var row *itemResult
	for i := range out.Items {
		if out.Items[i].ItemRef == "volume:srv1:pg1:dump" {
			row = &out.Items[i]
		}
	}
	if row == nil || row.State != "planned" || row.Reason != "would-stream-dump" || row.RawBytes != 34100000000 {
		t.Errorf("dump row: %+v", row)
	}
	if !hub.sawCall("/disk-check") {
		t.Error("the hub must be asked whether the target can take the transfer")
	}
}

func TestDryRunCountsTheDumpOfASmallDatabaseExactly(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted}, sizeOut: "52428800\n"}
	fakeDump(t, pgDump(40_000), nil)
	runDumpCLI(t, hub, d, "--arms", "all", "--dry-run", "--measure-dbs")
	m := hub.dbSizes[0].Items[0]
	if m.MeasuredBy != "dump" || m.DumpRawBytes == nil || *m.DumpRawBytes != 40_000 || m.DumpGzBytes == nil || *m.DumpGzBytes <= 0 {
		t.Errorf("a small database's dump is counted exactly: %+v", m)
	}
}

func TestDryRunWithoutMeasureFlagsNeverExecsAndReportsNothing(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted}, sizeOut: "1\n"}
	fakeDump(t, pgDump(10), nil)
	runDumpCLI(t, hub, d, "--arms", "all", "--dry-run")
	if d.saw("exec") || len(hub.dbSizes) != 0 {
		t.Error("a plain dry run is read-only and must not measure (no exec, no report)")
	}
}

func TestDryRunMeasureFailureIsReportedNotFatal(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted}, sizeErr: errors.New("exit 1")}
	fakeDump(t, pgDump(10), nil)
	runDumpCLI(t, hub, d, "--arms", "all", "--dry-run", "--measure-dbs")
	m := hub.dbSizes[0].Items[0]
	if m.State != "failed" || m.Reason != "size-exec" || m.DbBytes != 0 {
		t.Errorf("an unmeasurable database is reported failed with a fixed reason: %+v", m)
	}
}

// A dump client that dies says why: its last stderr line rides the error (and so the item reason the operator and the lab see).
func TestStartDumpFnCarriesTheClientsLastErrorLine(t *testing.T) {
	sh := filepath.Join(t.TempDir(), "fake-dump")
	if err := os.WriteFile(sh, []byte("#!/bin/sh\nprintf 'partial'\necho 'warming up' >&2\necho 'mariadb-dump: Error 2013: Lost connection to server during query' >&2\nexit 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, wait, err := startDumpFn(context.Background(), Plan{Argv: []string{sh}, Env: []string{"PATH=/usr/bin:/bin"}})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, out)
	werr := wait()
	if !errors.Is(werr, ErrDumpStream) || !strings.Contains(werr.Error(), "(exit 2): mariadb-dump: Error 2013: Lost connection") || strings.Contains(werr.Error(), "warming up") {
		t.Fatalf("wait error: %v", werr)
	}
	var res itemResult
	(&volRunner{}).setDumpFailure(context.Background(), &res, werr)
	if res.State != "failed" || !strings.HasPrefix(res.Reason, "dump-failed: (exit 2): mariadb-dump: Error 2013") {
		t.Fatalf("reason: %q", res.Reason)
	}
}
