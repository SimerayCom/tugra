package migrate

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const hostilePW = "p\"a\\ss$x&<>'`; rm -rf /"

func TestBuildPlanMongoKeepsThePasswordOffEveryArgv(t *testing.T) {
	p := parseGolden(t, "MONGO")
	host := map[string]string{"PATH": "/usr/bin", "TUGRA_MIGRATION_TOKEN": "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "TUGRA_DB_PW": "host-leftover"}
	plan, err := BuildPlan(p, Creds{Ctr: "deadbeef", User: "root", PW: hostilePW, HasPW: true}, "/usr/bin/docker", lookupOf(host))
	if err != nil {
		t.Fatal(err)
	}
	m := envToMap(plan.Env)
	if m["TUGRA_DB_PW"] != hostilePW {
		t.Errorf("the bound password must be the resolved one (never the host's leftover), got %q", m["TUGRA_DB_PW"])
	}
	if _, leak := m["TUGRA_MIGRATION_TOKEN"]; leak {
		t.Error("the migration token must never reach the child")
	}
	want := []string{"docker", "exec", "-e", "TUGRA_DB_PW", "deadbeef", "sh", "-c", mongoDumpBody, "tugra-mongo", "root"}
	if strings.Join(plan.Argv, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("argv: %v", plan.Argv)
	}
	for _, a := range plan.Argv {
		if strings.Contains(a, "rm -rf") || strings.Contains(a, "p\"a") {
			t.Fatalf("the password reached an argv word: %q", a)
		}
	}
	if plan.Format != "mongo_archive" {
		t.Errorf("format %q", plan.Format)
	}
}

func TestBuildPlanClickHouse(t *testing.T) {
	p := parseGolden(t, "CLICKHOUSE")
	plan, err := BuildPlan(p, Creds{Ctr: "deadbeef", User: "chu", DB: "appdb", PW: hostilePW, HasPW: true}, "/usr/bin/docker", lookupOf(map[string]string{"PATH": "/usr/bin"}))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"docker", "exec", "-e", "TUGRA_DB_PW", "deadbeef", "sh", "-c", chDumpBody, "tugra-clickhouse", "chu", "appdb"}
	if strings.Join(plan.Argv, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("argv: %v", plan.Argv)
	}
	if envToMap(plan.Env)["TUGRA_DB_PW"] != hostilePW || plan.Format != "clickhouse_zip" {
		t.Errorf("env/format: %v %q", plan.Env, plan.Format)
	}
}

func TestBuildPlanRefusesWhatAConfigFileCannotCarry(t *testing.T) {
	look := lookupOf(map[string]string{"PATH": "/usr/bin"})
	for _, pw := range []string{"", "line\nbreak", "nul\x00byte", "tab\tchar", strings.Repeat("x", 257)} {
		if _, err := BuildPlan(parseGolden(t, "MONGO"), Creds{Ctr: "deadbeef", User: "root", PW: pw, HasPW: pw != ""}, "docker", look); err == nil {
			t.Errorf("mongo: password %q must be refused", pw)
		}
	}
	// a ClickHouse database name is read back from a zip entry name: only letters, digits, underscore
	for _, db := range []string{"my.db", "a-b", "x+y", "", strings.Repeat("a", 64)} {
		if _, err := BuildPlan(parseGolden(t, "CLICKHOUSE"), Creds{Ctr: "deadbeef", User: "chu", DB: db, PW: "pw", HasPW: true}, "docker", look); err == nil {
			t.Errorf("clickhouse: database %q must be refused", db)
		}
	}
	if _, err := BuildPlan(parseGolden(t, "MONGO"), Creds{Ctr: "deadbeef", User: "-oops", PW: "pw", HasPW: true}, "docker", look); err == nil {
		t.Error("a user starting with '-' must be refused (option injection)")
	}
}

func TestResolveCredsMongoAndClickHouse(t *testing.T) {
	r, sk := resolveCreds("MONGO", inspectInfo{Env: []string{"MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD=s3"}})
	if sk != nil || r.user != "root" || r.pw != "s3" {
		t.Errorf("mongo: %+v %v", r, sk)
	}
	for name, env := range map[string][]string{
		"no user":     {"MONGO_INITDB_ROOT_PASSWORD=s3"},
		"no password": {"MONGO_INITDB_ROOT_USERNAME=root"},
		"nothing":     {},
	} {
		if _, sk := resolveCreds("MONGO", inspectInfo{Env: env}); sk == nil {
			t.Errorf("mongo %s: an instance without a discoverable root user is skipped, never dumped as if fine", name)
		}
	}
	if _, sk := resolveCreds("MONGO", inspectInfo{Env: []string{"MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD_FILE=/run/secrets/x"}}); sk == nil || sk.reason != skipSecretFile {
		t.Errorf("a *_FILE secret is never read: %v", sk)
	}

	r, sk = resolveCreds("CLICKHOUSE", inspectInfo{Env: []string{"CLICKHOUSE_USER=chu", "CLICKHOUSE_PASSWORD=pw", "CLICKHOUSE_DB=appdb"}})
	if sk != nil || r.user != "chu" || r.pw != "pw" || r.db != "appdb" {
		t.Errorf("clickhouse: %+v %v", r, sk)
	}
	r, _ = resolveCreds("CLICKHOUSE", inspectInfo{Env: []string{"CLICKHOUSE_USER=chu", "CLICKHOUSE_PASSWORD=pw"}})
	if r.db != "default" {
		t.Errorf("the documented image default database is `default`, got %q", r.db)
	}
	// a user from one tier is never paired with a password from the other
	if _, sk := resolveCreds("CLICKHOUSE", inspectInfo{Env: []string{"CLICKHOUSE_USER=chu", "CLICKHOUSE_ADMIN_PASSWORD=pw"}}); sk == nil {
		t.Error("tiers must not mix")
	}
	r, sk = resolveCreds("CLICKHOUSE", inspectInfo{Env: []string{"CLICKHOUSE_ADMIN_USER=adm", "CLICKHOUSE_ADMIN_PASSWORD=apw"}})
	if sk != nil || r.user != "adm" || r.pw != "apw" {
		t.Errorf("admin tier: %+v %v", r, sk)
	}
}

func TestClassifyEngineMongoAndClickHouse(t *testing.T) {
	cases := map[string]string{
		"mongo:7": "MONGO",
		"mongodb/mongodb-community-server:7.0-ubi8": "MONGO",
		"bitnami/mongodb:7":                         "MONGO",
		"clickhouse/clickhouse-server:24.8":         "CLICKHOUSE",
		"yandex/clickhouse-server:21.3":             "CLICKHOUSE",
		"mongo-express:1":                           "", // a web UI, not a database
	}
	for img, want := range cases {
		if got := classifyEngine(img, nil); got != want {
			t.Errorf("classify(%q)=%q want %q", img, got, want)
		}
	}
	if got := classifyEngine("registry.example.com/team/db:1", map[string]string{"MONGO_INITDB_ROOT_USERNAME": "root"}); got != "MONGO" {
		t.Errorf("env fallback (mongo): %q", got)
	}
	if got := classifyEngine("registry.example.com/team/db:1", map[string]string{"CLICKHOUSE_USER": "u"}); got != "CLICKHOUSE" {
		t.Errorf("env fallback (clickhouse): %q", got)
	}
}

func TestFormatSanityMongoAndClickHouse(t *testing.T) {
	if err := formatSanity("MONGO", []byte{0x6d, 0xe2, 0x99, 0x81, 0, 0, 0, 0}); err != nil {
		t.Errorf("a mongodump archive: %v", err)
	}
	if err := formatSanity("MONGO", []byte("PGDMP-not-mongo....")); err == nil {
		t.Error("garbage that exited 0 must not pass for a mongo archive")
	}
	if err := formatSanity("CLICKHOUSE", []byte("PK\x03\x04rest of a zip")); err != nil {
		t.Errorf("a zip: %v", err)
	}
	if err := formatSanity("CLICKHOUSE", []byte("Code: 81. DB::Exception")); err == nil {
		t.Error("an error text must not pass for a ClickHouse backup")
	}
}

func TestSizeAndVerifyPlansForMongoAndClickHouse(t *testing.T) {
	look := lookupOf(map[string]string{"PATH": "/usr/bin"})
	mc := Creds{Ctr: "deadbeef", User: "root", PW: hostilePW, HasPW: true}
	sp, err := buildSizePlan("MONGO", mc, "docker", look)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(sp.Argv, "\x00") != strings.Join([]string{"docker", "exec", "-e", "TUGRA_DB_PW", "deadbeef", "sh", "-c", mongoShellBody, "tugra-size", "root", "exact", "1", mongoSizeJS}, "\x00") {
		t.Errorf("mongo size argv: %v", sp.Argv)
	}
	cc := Creds{Ctr: "deadbeef", User: "chu", DB: "appdb", PW: hostilePW, HasPW: true}
	sp, err = buildSizePlan("CLICKHOUSE", cc, "docker", look)
	if err != nil || strings.Join(sp.Argv, "\x00") != strings.Join([]string{"docker", "exec", "-e", "TUGRA_DB_PW", "deadbeef", "sh", "-c", chSizeBody, "tugra-size", "chu", "appdb"}, "\x00") {
		t.Errorf("clickhouse size argv: %v %v", sp.Argv, err)
	}
	vp, err := buildVerifyPlan("MONGO", mc, verifyModeEstimate, 500, "docker", look)
	if err != nil || strings.Join(vp.Argv, "\x00") != strings.Join([]string{"docker", "exec", "-e", "TUGRA_DB_PW", "deadbeef", "sh", "-c", mongoShellBody, "tugra-verify", "root", "estimate", "500", mongoStatsJS}, "\x00") {
		t.Errorf("mongo verify argv: %v %v", vp.Argv, err)
	}
	vp, err = buildVerifyPlan("CLICKHOUSE", cc, verifyModeExact, 10, "docker", look)
	if err != nil || strings.Join(vp.Argv, "\x00") != strings.Join([]string{"docker", "exec", "-e", "TUGRA_DB_PW", "deadbeef", "sh", "-c", chStatsBody, "tugra-verify", "chu", "appdb", "exact", "10"}, "\x00") {
		t.Errorf("clickhouse verify argv: %v %v", vp.Argv, err)
	}
	for _, p := range []Plan{sp, vp} {
		for _, a := range p.Argv {
			if strings.Contains(a, "rm -rf") {
				t.Fatalf("the password reached an argv word: %q", a)
			}
		}
	}
	if verifyKind("MONGO") != "tables" || verifyKind("CLICKHOUSE") != "tables" {
		t.Error("collections and tables are counted as tables")
	}
	if !isDumpEngine("MONGO") || !isDumpEngine("CLICKHOUSE") || isDumpEngine("REDIS") {
		t.Error("the dump lane covers mongo and clickhouse")
	}
}

// ---- the real bodies, through a real sh, with stub clients ------------------------------------------------------------------------

// runBody runs `sh -c body args...` with the password in the environment and stub binaries first on PATH. It returns stdout and stderr.
func runBody(t *testing.T, stubs map[string]string, body, pw string, args ...string) (string, string, error) {
	t.Helper()
	dir := t.TempDir()
	for name, script := range stubs {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", append([]string{"-c", body, "tugra-test"}, args...)...)
	cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin", "TUGRA_DB_PW=" + pw, "TMPDIR=" + dir}
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err := cmd.Run()
	return so.String(), se.String(), err
}

func TestMongoDumpBodyWritesTheConfigFileAndNeverPutsThePasswordOnAnArgv(t *testing.T) {
	cap := filepath.Join(t.TempDir(), "capture")
	// the stub answers `--help` like the real tool (so the --config probe passes), else records its argv and the config file it was given
	stub := `case "$*" in *--help*) echo "      --config=  path to a configuration file";; *) echo "ARGV: $*" > ` + cap + `; for a in "$@"; do case "$a" in --config=*) f="${a#--config=}";; esac; done; if [ "$1" = --config ]; then f="$2"; fi; echo "MODE: $(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" >> ` + cap + `; printf "CFG: %s\n" "$(cat "$f")" >> ` + cap + `; printf archive;; esac`
	before := dbcfgFiles()
	out, stderr, err := runBody(t, map[string]string{"mongodump": stub}, mongoDumpBody, hostilePW, "root")
	if err != nil || out != "archive" {
		t.Fatalf("out=%q err=%v stderr=%s", out, err, stderr)
	}
	b, _ := os.ReadFile(cap)
	got := string(b)
	if strings.Contains(strings.SplitN(got, "\n", 2)[0], "ss$x") || strings.Contains(strings.SplitN(got, "\n", 2)[0], "p\"a") {
		t.Fatalf("the password is on the client's argv: %s", got)
	}
	if !strings.Contains(got, "--username root --authenticationDatabase admin --archive") {
		t.Errorf("argv: %s", got)
	}
	if !strings.Contains(got, "MODE: 600") {
		t.Errorf("the config file must be owner-only: %s", got)
	}
	// YAML double-quoted scalar: `\` and `"` escaped, everything else literal
	if !strings.Contains(got, `CFG: password: "p\"a\\ss$x&<>'`+"`"+`; rm -rf /"`) {
		t.Errorf("config file content: %s", got)
	}
	if left := dbcfgFiles(); len(left) != len(before) {
		t.Errorf("the config file outlived the dump: %v", left)
	}
}

// dbcfgFiles lists the config files the bodies create (in /tmp: macOS has no /dev/shm, a container does).
func dbcfgFiles() []string {
	a, _ := filepath.Glob("/tmp/tugra-dbcfg.*")
	b, _ := filepath.Glob("/dev/shm/tugra-dbcfg.*")
	return append(a, b...)
}

func TestMongoDumpBodyFailsClosedWhenTheToolCannotReadAConfigFile(t *testing.T) {
	_, stderr, err := runBody(t, map[string]string{"mongodump": `echo "no such option here"`}, mongoDumpBody, "pw", "root")
	if err == nil || !strings.Contains(stderr, "has no --config") {
		t.Errorf("an old mongodump must stop, never fall back to --password: err=%v stderr=%s", err, stderr)
	}
}

func TestClickHouseStatsBodyCountsEveryTableAndKeepsThePasswordInAConfigFile(t *testing.T) {
	cap := filepath.Join(t.TempDir(), "capture")
	before := dbcfgFiles()
	stub := `cfg=""; q=""; while [ $# -gt 0 ]; do case "$1" in --config-file) cfg="$2"; shift;; --query) q="$2"; shift;; esac; shift; done
printf "CFG: %s\n" "$(cat "$cfg")" >> ` + cap + `
case "$q" in
 "SELECT 1") echo 1;;
 *"FROM system.tables"*) printf 't1\t1000\nt2\t\\N\nweird-name\t5\n';;
 *"count()"*) echo 7;;
esac`
	out, stderr, err := runBody(t, map[string]string{"clickhouse-client": stub}, chStatsBody, "p\"<&>pw", "chu", "appdb", "exact", "10")
	if err != nil {
		t.Fatalf("err=%v stderr=%s", err, stderr)
	}
	want := "t1\t7\t0\nt2\t7\t0\nweird-name\t-1\t0\n"
	if out != want {
		t.Errorf("stats:\n got %q\nwant %q", out, want)
	}
	if _, perr := parseTableLines(out); perr != nil {
		t.Errorf("the output must parse as table lines: %v", perr)
	}
	b, _ := os.ReadFile(cap)
	if !strings.Contains(string(b), `CFG: <clickhouse><user>chu</user><password>p"&lt;&amp;&gt;pw</password></clickhouse>`) {
		t.Errorf("config file content (XML-escaped): %s", b)
	}
	if left := dbcfgFiles(); len(left) != len(before) {
		t.Errorf("the config file outlived the statement: %v", left)
	}
	// estimate mode: a table at or above the threshold is the metadata count, flagged estimated, and is not counted
	out, _, err = runBody(t, map[string]string{"clickhouse-client": stub}, chStatsBody, "pw", "chu", "appdb", "estimate", "500")
	if err != nil || out != "t1\t1000\t1\nt2\t7\t0\nweird-name\t-1\t0\n" {
		t.Errorf("estimate: %q %v", out, err)
	}
}

func TestMongoStatsWrapperHandsTheUserModeAndScriptAsParameters(t *testing.T) {
	cap := filepath.Join(t.TempDir(), "capture")
	stub := `echo "$*" > ` + cap + `; echo "PW:$TUGRA_DB_PW" >> ` + cap + `; echo 'db.items\t3\t0'`
	_, _, err := runBody(t, map[string]string{"mongosh": stub}, mongoShellBody, "pw1", "root", "exact", "1000", "THE-SCRIPT")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(cap)
	if !strings.Contains(string(b), `--quiet --norc --eval var U="root",M="exact",B=1000; THE-SCRIPT`) || !strings.Contains(string(b), "PW:pw1") {
		t.Errorf("wrapper: %s", b)
	}
}

// ---- a plain run: a database whose dump is over the artifact cap moves by the streamed lane --------------------------------------

const (
	plainDbRow      = `{"itemRef":"database:srv1:pg1","kind":"database","engine":"POSTGRES"}`
	plainDbRowVol   = `{"itemRef":"database:srv1:pg1","kind":"database","engine":"POSTGRES","dataPlane":"volume"}`
	dumpVolRowByRun = `{"itemRef":"volume:srv1:pg1:dump","kind":"volume","volumeIngest":"stream-dump","dest":{"type":"db-dump","name":"dump","mountPath":""},"databaseItemRef":"database:srv1:pg1","engine":"POSTGRES","engineVersion":"16","sourceImage":"postgres:16-alpine","streamedByMigrator":true}`
)

// bigDumpDocker puts a `docker` on PATH whose `exec` writes 300 KiB of incompressible bytes (a dump over a tiny cap).
func bigDumpDocker(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = exec ]; then printf 'PGDMP'; head -c 300000 /dev/urandom; fi\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

func runPlain(t *testing.T, hub *streamHub, d *dumpDocker, args ...string) (output, int, string) {
	t.Helper()
	noSleep(t)
	bigDumpDocker(t)
	srv := hub.serve(t)
	t.Cleanup(srv.Close)
	d.install(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	var stdout, stderr bytes.Buffer
	base := []string{"--hub", srv.URL, "--helper-image", "img:1", "--part-mib", "128", "--max-gz-bytes", "20000"}
	code := RunCLI(append(base, args...), "test", &stdout, &stderr)
	var out output
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil {
		t.Fatalf("stdout is not one JSON line: %v\n%s\nstderr:%s", err, stdout.String(), stderr.String())
	}
	return out, code, stderr.String()
}

func plainHub(t *testing.T, targets string) *streamHub {
	h := streamHubWith(t, targets)
	h.recipes = pgRecipes()
	return h
}

func TestPlainRunMovesADumpOverTheCapByTheStreamedLane(t *testing.T) {
	hub := plainHub(t, withPolicy(plainDbRow))
	hub.targetsAfterStream = withPolicy(plainDbRowVol, dumpVolRowByRun)
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	stream := pgDump(3000)
	fakeDump(t, stream, nil)
	out, code, stderr := runPlain(t, hub, d)
	if code != exitOK {
		t.Fatalf("exit=%d out=%+v stderr=%s", code, out, stderr)
	}
	if len(out.Items) != 1 || out.Items[0].ItemRef != "database:srv1:pg1" || out.Items[0].State != "restored" || out.Items[0].Reason != "streamed" || out.Items[0].RawBytes != 3000 {
		t.Fatalf("the database is reported restored by the stream: %+v", out.Items)
	}
	if out.Counts.Restored != 1 || out.Counts.Failed != 0 {
		t.Errorf("counts: %+v", out.Counts)
	}
	if len(hub.dbStreams) != 1 || hub.dbStreams[0] != "database:srv1:pg1" {
		t.Errorf("the hub is asked once for the lane: %v", hub.dbStreams)
	}
	if got := reassemble(t, hub.fakeRelayHub, 1); !bytes.Equal(got, stream) {
		t.Error("the relay received something other than the dump")
	}
	if len(hub.begins) != 1 || len(hub.finishes) != 1 {
		t.Errorf("begin/finish: %d/%d", len(hub.begins), len(hub.finishes))
	}
	if hub.sawCall("artifacts/database") && hub.sawCall("PUT artifacts") {
		t.Error("the over-cap artifact must never be uploaded")
	}
}

func TestPlainRunKeepsTheOldFailureWhenTheLaneIsNotAvailable(t *testing.T) {
	for name, tc := range map[string]struct {
		targets string
		status  int
		args    []string
		asks    bool
	}{
		"the operator opted out":       {targets: withPolicy(plainDbRow), args: []string{"--no-stream-large"}},
		"the hub offers no vx":         {targets: `{"opId":"op1","targets":[` + plainDbRow + `],"maxArtifactBytes":268435456}`},
		"the owner of the run refuses": {targets: withPolicy(plainDbRow), status: 409, asks: true},
	} {
		t.Run(name, func(t *testing.T) {
			hub := plainHub(t, tc.targets)
			hub.dbStreamStatus = tc.status
			d := &dumpDocker{running: true, started: []string{dumpStarted}}
			out, code, _ := runPlain(t, hub, d, tc.args...)
			if code != exitPartial || len(out.Items) != 1 || out.Items[0].State != "failed" || out.Items[0].Reason != "dump-too-big" {
				t.Errorf("code=%d %+v", code, out.Items)
			}
			if (len(hub.dbStreams) > 0) != tc.asks {
				t.Errorf("asked for the lane: %v, want %v", len(hub.dbStreams) > 0, tc.asks)
			}
			if len(hub.begins) != 0 {
				t.Error("nothing is streamed when the lane is refused")
			}
		})
	}
}

func TestPlainRunResumesAStreamItStartedAndLeavesAGuidedRunsRowsAlone(t *testing.T) {
	// a database a PREVIOUS run put on the lane (the hub marks the row streamedByMigrator): this databases-arm run resumes it
	hub := plainHub(t, withPolicy(plainDbRowVol, dumpVolRowByRun))
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	fakeDump(t, pgDump(3000), nil)
	out, code, stderr := runPlain(t, hub, d)
	if code != exitOK || len(out.Items) != 1 || out.Items[0].State != "restored" || len(hub.begins) != 1 {
		t.Fatalf("resume: code=%d %+v begins=%d stderr=%s", code, out.Items, len(hub.begins), stderr)
	}
	if len(hub.dbStreams) != 0 {
		t.Error("a resume does not ask the hub again")
	}

	// a row a guided run chose (no streamedByMigrator) is the volume arm's: the databases arm skips it, exactly as before
	hub2 := plainHub(t, withPolicy(plainDbRowVol, dumpVolRow))
	fakeDump(t, pgDump(3000), nil)
	out, code, _ = runPlain(t, hub2, &dumpDocker{running: true, started: []string{dumpStarted}})
	if code != exitPartial || len(out.Items) != 1 || out.Items[0].State != "skipped" || out.Items[0].Reason != "volume-mode" || len(hub2.begins) != 0 {
		t.Errorf("a guided run's row: code=%d %+v", code, out.Items)
	}
}
