package migrate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
)

const verifyTestToken = "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestParseTableLines(t *testing.T) {
	got, err := parseTableLines("public.users\t42\t0\r\npublic.ticks\t9000000\t1\n\nsales.orders\t-1\t0\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []VerifyTable{{Name: "public.users", Rows: 42}, {Name: "public.ticks", Rows: 9000000, Estimated: true}, {Name: "sales.orders", Rows: -1}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %+v want %+v", got, want)
	}
	if got, err := parseTableLines(""); err != nil || len(got) != 0 {
		t.Errorf("an empty answer is a database with no tables: %v %v", got, err)
	}
	for _, bad := range []string{
		"only-one-field\n",
		"a\tb\t0\n",        // rows not a number
		"a\t5\t2\n",        // bad estimated flag
		"a\t-2\t0\n",       // below the "not counted" marker
		"\t5\t0\n",         // empty name
		"a\t5\t0\textra\n", // too many fields
		"psql: error: connection to server failed\n",
	} {
		if _, err := parseTableLines(bad); err == nil {
			t.Errorf("a malformed line must fail the whole answer: %q", bad)
		}
	}
}

func TestParseKeyspace(t *testing.T) {
	got, err := parseKeyspace("# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=1000\r\ndb2:keys=1,expires=0,avg_ttl=0,subexpiry=0\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != (VerifyTable{Name: "db0", Rows: 12, Expires: 3}) || got[1] != (VerifyTable{Name: "db2", Rows: 1}) {
		t.Errorf("got %+v", got)
	}
	if got, err := parseKeyspace("# Keyspace\r\n"); err != nil || len(got) != 0 {
		t.Errorf("an empty keyspace is zero keys, not an error: %v %v", got, err)
	}
	for _, bad := range []string{
		"",                                  // nothing at all
		"NOAUTH Authentication required.\n", // redis-cli exits 0 with this: NOT an empty keyspace
		"# Keyspace\ndb0:keys=x\n",
		"# Keyspace\ndb0:expires=3\n", // no keys field
		"# Keyspace\ndbx:keys=1\n",
		"# Keyspace\nWARNING something\n",
	} {
		if _, err := parseKeyspace(bad); err == nil {
			t.Errorf("must fail closed: %q", bad)
		}
	}
}

func TestBuildVerifyPlanArgvAndEnvPerEngine(t *testing.T) {
	look := func(k string) (string, bool) {
		switch k {
		case "PATH":
			return "/usr/bin", true
		case "TUGRA_MIGRATION_TOKEN", "PGPASSWORD", "AWS_SECRET_ACCESS_KEY":
			return "must-not-pass", true
		}
		return "", false
	}
	c := Creds{Ctr: pgID, User: "app", DB: "appdb", PW: "s3cr3t", HasPW: true}
	cases := []struct {
		engine, bind string
		argvHas      []string
	}{
		{"POSTGRES", "PGPASSWORD", []string{"exec", "-e", "PGPASSWORD", pgID, "psql", "-X", "-q", "-A", "-t", "-U", "app", "-d", "appdb", "-c"}},
		{"MYSQL", "MYSQL_PWD", []string{"exec", "-e", "MYSQL_PWD", pgID, "sh", "-c", "tugra-verify", "app", "appdb", "estimate", "1000000"}},
		{"MARIADB", "MYSQL_PWD", []string{"sh", "-c", "tugra-verify", "app", "appdb"}},
		{"REDIS", "REDISCLI_AUTH", []string{"exec", "-e", "REDISCLI_AUTH", pgID, "redis-cli", "--no-auth-warning", "INFO", "keyspace"}},
		{"KEYDB", "REDISCLI_AUTH", []string{"keydb-cli", "--no-auth-warning", "INFO", "keyspace"}},
		{"DRAGONFLY", "REDISCLI_AUTH", []string{"redis-cli", "INFO", "keyspace"}},
	}
	for _, tc := range cases {
		p, err := buildVerifyPlan(tc.engine, c, verifyModeEstimate, defaultVerifyExactBelow, "/usr/bin/docker", look)
		if err != nil {
			t.Fatalf("%s: %v", tc.engine, err)
		}
		joined := strings.Join(p.Argv, "\x00")
		for _, w := range tc.argvHas {
			if !strings.Contains(joined, w) {
				t.Errorf("%s: argv lacks %q: %q", tc.engine, w, p.Argv)
			}
		}
		if strings.Contains(joined, "s3cr3t") {
			t.Errorf("%s: the password must never be on an argv: %q", tc.engine, p.Argv)
		}
		if p.Argv[0] != "/usr/bin/docker" {
			t.Errorf("%s: argv[0] is the pre-resolved docker path", tc.engine)
		}
		env := strings.Join(p.Env, "\n")
		if !strings.Contains(env, tc.bind+"=s3cr3t") {
			t.Errorf("%s: the one bound secret must be in the child env: %s", tc.engine, env)
		}
		for _, leak := range []string{"TUGRA_MIGRATION_TOKEN", "must-not-pass", "AWS_SECRET"} {
			if strings.Contains(env, leak) {
				t.Errorf("%s: %s leaked into the child env", tc.engine, leak)
			}
		}
		if len(p.Env) == 0 {
			t.Errorf("%s: an empty Env would inherit os.Environ()", tc.engine)
		}
	}
}

func TestBuildVerifyPlanRefusesUnsafeValues(t *testing.T) {
	look := func(string) (string, bool) { return "", false }
	good := Creds{Ctr: pgID, User: "app", DB: "appdb", PW: "x", HasPW: true}
	for name, c := range map[string]Creds{
		"option-injecting user": {Ctr: pgID, User: "-oProxy", DB: "d", PW: "x", HasPW: true},
		"shell db":              {Ctr: pgID, User: "app", DB: "d;rm", PW: "x", HasPW: true},
		"bad container":         {Ctr: "-x", User: "app", DB: "d", PW: "x", HasPW: true},
	} {
		if _, err := buildVerifyPlan("POSTGRES", c, verifyModeExact, 10, "docker", look); err == nil {
			t.Errorf("%s must be refused", name)
		}
		if _, err := buildVerifyPlan("MYSQL", c, verifyModeExact, 10, "docker", look); err == nil {
			t.Errorf("%s must be refused (mysql)", name)
		}
	}
	for _, mode := range []string{"", "fast", "EXACT"} {
		if _, err := buildVerifyPlan("POSTGRES", good, mode, 10, "docker", look); err == nil {
			t.Errorf("mode %q must be refused", mode)
		}
	}
	for _, below := range []int64{0, -5, 2_000_000_000_000} {
		if _, err := buildVerifyPlan("POSTGRES", good, verifyModeEstimate, below, "docker", look); err == nil {
			t.Errorf("threshold %d must be refused", below)
		}
	}
	if _, err := buildVerifyPlan("LIBSQL", good, verifyModeExact, 10, "docker", look); err == nil {
		t.Error("an engine without a verify statement must be refused")
	}
	// redis family needs neither user nor db: a bad user is irrelevant
	if _, err := buildVerifyPlan("REDIS", Creds{Ctr: pgID, PW: "x", HasPW: true}, verifyModeExact, 10, "docker", look); err != nil {
		t.Errorf("redis needs only a container: %v", err)
	}
	// an unresolved password is OMITTED, never exported blank
	p, err := buildVerifyPlan("REDIS", Creds{Ctr: pgID}, verifyModeExact, 10, "docker", look)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range p.Env {
		if strings.HasPrefix(e, "REDISCLI_AUTH=") {
			t.Errorf("an unresolved password must not be exported blank: %v", p.Env)
		}
	}
}

// The statements are part of the contract with the hub (which builds the identical ones for the TARGET side and parses
// the identical shape). These goldens fail loudly if either side drifts.
func TestVerifyStatementsGolden(t *testing.T) {
	exact := pgSQL(verifyModeExact, 1)
	if !strings.HasPrefix(exact, `SELECT n.nspname || '.' || c.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text, '0' FROM pg_class c`) {
		t.Errorf("exact SQL drifted: %s", exact)
	}
	if !strings.HasSuffix(exact, `AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%' ORDER BY 1`) || strings.Contains(exact, "reltuples") {
		t.Errorf("exact SQL must not consult planner estimates: %s", exact)
	}
	est := pgSQL(verifyModeEstimate, 250000)
	if strings.Count(est, "c.reltuples >= 250000") != 2 || !strings.Contains(est, "THEN '1' ELSE '0' END") {
		t.Errorf("estimate SQL drifted: %s", est)
	}
	if !strings.Contains(est, "NOT c.relispartition") || !strings.Contains(est, "c.relkind IN ('r','p')") {
		t.Errorf("only base tables (parents of partitions) are counted: %s", est)
	}
	body := mysqlVerifyBody("mysql")
	for _, must := range []string{
		`mysql -u"$1" --protocol=TCP -h127.0.0.1 -N -B`,
		`|| exit 1;`, // a failed listing is a failure, never an empty success
		"FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'",
		"*[!A-Za-z0-9_$]*) printf '%s\\t-1\\t0\\n'", // exotic names are reported uncounted, never interpolated
		`[ "$3" = estimate ] && [ "$est" -ge "$4" ]`,
		"SELECT COUNT(*) FROM \\`$t\\`",
	} {
		if !strings.Contains(body, must) {
			t.Errorf("mysql body lacks %q:\n%s", must, body)
		}
	}
	if !strings.Contains(mysqlVerifyBody("mariadb"), `mariadb -u"$1"`) || strings.Contains(mysqlVerifyBody("mariadb"), "mysql -u") {
		t.Error("the mariadb body must use the mariadb client only")
	}
	for _, secret := range []string{"MYSQL_PWD", "PASSWORD"} {
		if strings.Contains(body, secret) {
			t.Errorf("the body must not name the password: %s", secret)
		}
	}
}

// ---- end to end against a scripted hub and a scripted docker -------------------------------------------------

type verifyHub struct {
	mu      sync.Mutex
	targets string
	got     []VerifyItem
	status  int
	calls   []string
	// maxBody > 0 mimics the hub's framework JSON body limit: a larger request is answered 413 and stores nothing.
	maxBody int
	bodies  []int
}

func (h *verifyHub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/api/v1/import/migration/")
		h.mu.Lock()
		h.calls = append(h.calls, r.Method+" "+p)
		h.mu.Unlock()
		switch p {
		case "probe":
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case "recipes":
			io.WriteString(w, `{"v":1,"recipes":{},"unsupported":{}}`)
		case "targets":
			io.WriteString(w, h.targets)
		case "verify":
			if h.status != 0 {
				w.WriteHeader(h.status)
				io.WriteString(w, `{"message":"nope"}`)
				return
			}
			raw, _ := io.ReadAll(r.Body)
			h.mu.Lock()
			h.bodies = append(h.bodies, len(raw))
			h.mu.Unlock()
			if h.maxBody > 0 && len(raw) > h.maxBody {
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				io.WriteString(w, `{"message":"request entity too large"}`)
				return
			}
			var body verifyReq
			_ = json.Unmarshal(raw, &body)
			h.mu.Lock()
			h.got = append(h.got, body.Items...)
			h.mu.Unlock()
			io.WriteString(w, fmt.Sprintf(`{"stored":%d}`, len(body.Items)))
		default:
			http.NotFound(w, r)
		}
	})
}

const dbTargets = `{"opId":"op1","targets":[` +
	`{"itemRef":"database:_:mypg","kind":"database","engine":"POSTGRES","dataPlane":"logical"},` +
	`{"itemRef":"database:_:myrd","kind":"database","engine":"REDIS","dataPlane":"logical"},` +
	`{"itemRef":"database:_:stopped","kind":"database","engine":"POSTGRES","dataPlane":"volume"}` +
	`],"maxArtifactBytes":268435456,"vxProtocol":1,"vx":{"partRawBytes":134217728,"maxBytes":274877906944,"maxParts":100000}}`

// verifyDocker serves ps/inspect for the fixed containers and records every `exec` (argv + env).
type verifyDocker struct {
	mu    sync.Mutex
	execs [][]string
	envs  [][]string
	out   map[string]string // argv[4] container id -> stdout
	fail  map[string]bool
}

func (d *verifyDocker) install(t *testing.T, cs []fakeContainer) {
	t.Helper()
	withFakeDocker(t, cs)
	base := runDocker
	t.Cleanup(func() { runDocker = base })
	runDocker = func(ctx context.Context, argv []string, env []string) ([]byte, string, error) {
		if len(argv) >= 2 && argv[1] == "exec" {
			d.mu.Lock()
			d.execs = append(d.execs, append([]string(nil), argv...))
			d.envs = append(d.envs, append([]string(nil), env...))
			d.mu.Unlock()
			ctr := ""
			for i, a := range argv {
				if i >= 2 && !strings.HasPrefix(a, "-") && argv[i-1] != "-e" {
					ctr = a
					break
				}
			}
			if d.fail[ctr] {
				return nil, "boom", fmt.Errorf("exit 1")
			}
			return []byte(d.out[ctr]), "", nil
		}
		return base(ctx, argv, env)
	}
}

func runVerify(t *testing.T, srv *httptest.Server, args ...string) (output, int, string) {
	t.Helper()
	t.Setenv("TUGRA_MIGRATION_TOKEN", verifyTestToken)
	stubDockerOnPath(t)
	var stdout, stderr bytes.Buffer
	code := RunCLI(append([]string{"--hub", srv.URL}, args...), "test", &stdout, &stderr)
	var out output
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil {
		t.Fatalf("stdout is not one JSON line: %v\n%s", err, stdout.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), "tugra_mig_aaaa") || strings.Contains(stdout.String()+stderr.String(), "pgpw") || strings.Contains(stdout.String()+stderr.String(), "rdpw") {
		t.Error("a secret leaked into the output")
	}
	return out, code, stderr.String()
}

func TestVerifyOnlyRunMeasuresEveryDatabaseAndReports(t *testing.T) {
	hub := &verifyHub{targets: dbTargets}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	d := &verifyDocker{out: map[string]string{
		pgID:    "public.users\t42\t0\npublic.ticks\t9000000\t1\n",
		otherID: "# Keyspace\r\ndb0:keys=7,expires=2,avg_ttl=5\r\n",
	}}
	d.install(t, []fakeContainer{
		{id: pgID, name: "mypg", image: "postgres:16", running: true, envv: []string{"POSTGRES_USER=app", "POSTGRES_PASSWORD=pgpw", "POSTGRES_DB=appdb"}},
		{id: otherID, name: "myrd", image: "redis:7", running: true, envv: []string{"REDIS_PASSWORD=rdpw"}},
		{id: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", name: "stopped", image: "postgres:16", running: false, envv: []string{"POSTGRES_PASSWORD=x"}},
	})

	// `--arms volumes` + no volume targets: nothing to copy, so the run is a verify-only pass (NoTargets).
	out, code, stderr := runVerify(t, srv, "--arms", "volumes", "--verify", "--verify-mode", "exact", "--helper-image", "img:1")
	if !out.NoTargets || out.Verify == nil {
		t.Fatalf("expected a verify-only run: %+v stderr=%s", out, stderr)
	}
	// the stopped (volume-mode) database is skipped, so a clean copy still ends partial: the hub needs the whole truth
	if code != exitPartial {
		t.Errorf("exit=%d want %d (a skipped verify item downgrades a clean run)", code, exitPartial)
	}
	if out.Verify.Measured != 2 || out.Verify.Skipped != 1 || out.Verify.Failed != 0 || !out.Verify.Reported {
		t.Fatalf("verify summary: %+v", out.Verify)
	}
	byRef := map[string]VerifyItem{}
	for _, it := range hub.got {
		byRef[it.ItemRef] = it
	}
	pg := byRef["database:_:mypg"]
	if pg.State != "measured" || pg.Kind != "tables" || pg.Mode != "exact" || pg.TableCount != 2 || pg.Tables[1].Estimated != true || pg.Tables[0].Rows != 42 {
		t.Errorf("postgres item: %+v", pg)
	}
	rd := byRef["database:_:myrd"]
	if rd.State != "measured" || rd.Kind != "keys" || rd.Tables[0].Name != "db0" || rd.Tables[0].Rows != 7 || rd.Tables[0].Expires != 2 {
		t.Errorf("redis item: %+v", rd)
	}
	st := byRef["database:_:stopped"]
	if st.State != "skipped" || st.Reason != "not-running" {
		t.Errorf("a stopped database must be reported skipped:not-running, never an empty success: %+v", st)
	}
	// every docker exec is read-only and the password never reached an argv or the output
	for i, argv := range d.execs {
		joined := strings.Join(argv, " ")
		if strings.Contains(joined, "pgpw") || strings.Contains(joined, "rdpw") {
			t.Errorf("password on argv: %s", joined)
		}
		if strings.Contains(joined, "SAVE") || strings.Contains(joined, "pg_dump") || strings.Contains(joined, "DELETE") {
			t.Errorf("verify must be read-only: %s", joined)
		}
		env := strings.Join(d.envs[i], "\n")
		if strings.Contains(env, "TUGRA_MIGRATION_TOKEN") {
			t.Errorf("the migration token reached a docker child: %s", env)
		}
	}
	if len(d.execs) != 2 {
		t.Errorf("two measured databases => two execs, got %d", len(d.execs))
	}
}

func TestVerifyFailuresAreExplicitAndNeverEmptySuccess(t *testing.T) {
	hub := &verifyHub{targets: dbTargets}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	d := &verifyDocker{
		out:  map[string]string{otherID: "NOAUTH Authentication required.\n"},
		fail: map[string]bool{pgID: true},
	}
	d.install(t, []fakeContainer{
		{id: pgID, name: "mypg", image: "postgres:16", running: true, envv: []string{"POSTGRES_USER=app", "POSTGRES_PASSWORD=pgpw", "POSTGRES_DB=appdb"}},
		{id: otherID, name: "myrd", image: "redis:7", running: true, envv: []string{"REDIS_PASSWORD=rdpw"}},
	})
	out, code, _ := runVerify(t, srv, "--arms", "volumes", "--verify", "--only", "database:_:mypg", "--only", "database:_:myrd", "--helper-image", "img:1")
	if code != exitPartial || out.Verify == nil || out.Verify.Failed != 2 || out.Verify.Measured != 0 {
		t.Fatalf("code=%d verify=%+v", code, out.Verify)
	}
	reasons := map[string]string{}
	for _, it := range out.Verify.Items {
		reasons[it.ItemRef] = it.Reason
		if len(it.Tables) != 0 {
			t.Errorf("a failed item carries no numbers: %+v", it)
		}
	}
	if reasons["database:_:mypg"] != "verify-exec" || reasons["database:_:myrd"] != "verify-parse" {
		t.Errorf("reasons: %v", reasons)
	}
}

func TestVerifyHubRejectionIsAnAbortWhenAuthAndPartialOtherwise(t *testing.T) {
	d := &verifyDocker{out: map[string]string{otherID: "# Keyspace\n"}}
	targets := `{"opId":"op1","targets":[{"itemRef":"database:_:myrd","kind":"database","engine":"REDIS","dataPlane":"logical"}],"maxArtifactBytes":268435456,"vxProtocol":1,"vx":{"partRawBytes":134217728,"maxBytes":274877906944,"maxParts":100000}}`
	for status, want := range map[int]int{401: exitAuth, 400: exitPartial} {
		hub := &verifyHub{targets: targets, status: status}
		srv := httptest.NewServer(hub.handler())
		d.install(t, []fakeContainer{{id: otherID, name: "myrd", image: "redis:7", running: true, envv: []string{"REDIS_PASSWORD=rdpw"}}})
		out, code, _ := runVerify(t, srv, "--arms", "volumes", "--verify", "--helper-image", "img:1")
		srv.Close()
		if code != want {
			t.Errorf("hub %d: exit=%d want %d", status, code, want)
		}
		if status == 400 && (out.Verify == nil || out.Verify.Reported) {
			t.Errorf("an unreported verify must say so: %+v", out.Verify)
		}
	}
}

func TestVerifyFlagValidation(t *testing.T) {
	t.Setenv("TUGRA_MIGRATION_TOKEN", verifyTestToken)
	for _, args := range [][]string{
		{"--hub", "https://h.example", "--verify", "--verify-mode", "fast"},
		{"--hub", "https://h.example", "--verify", "--verify-exact-below", "0"},
	} {
		var stdout, stderr bytes.Buffer
		if code := RunCLI(args, "test", &stdout, &stderr); code != exitUsage {
			t.Errorf("%v: exit=%d want usage", args, code)
		}
	}
}

func TestVerifyIsOffByDefaultAndDryRunNeverRunsIt(t *testing.T) {
	hub := &verifyHub{targets: dbTargets}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	d := &verifyDocker{out: map[string]string{}}
	d.install(t, []fakeContainer{{id: pgID, name: "mypg", image: "postgres:16", running: true, envv: []string{"POSTGRES_PASSWORD=pgpw"}}})
	out, _, _ := runVerify(t, srv, "--arms", "volumes", "--helper-image", "img:1")
	if out.Verify != nil || len(d.execs) != 0 {
		t.Errorf("verify must be opt-in: %+v", out.Verify)
	}
	for _, c := range hub.calls {
		if strings.Contains(c, "verify") {
			t.Errorf("no verify call without --verify: %v", hub.calls)
		}
	}
	out, _, _ = runVerify(t, srv, "--arms", "databases", "--dry-run", "--verify", "--only", "database:_:mypg")
	if len(d.execs) != 0 {
		t.Errorf("a dry run must not exec anything: %v", d.execs)
	}
	_ = out
}

// The in-container MySQL body really runs under /bin/sh: a fake `mysql` client plays the server, so the loop, the
// quoting, the estimate switch and the failure paths are exercised for real (no docker needed).
func TestMysqlVerifyBodyRunsUnderShWithAFakeClient(t *testing.T) {
	dir := t.TempDir()
	fake := `#!/bin/sh
# args: -uUSER --protocol=TCP -h127.0.0.1 -N -B -e SQL DB
sql=""; while [ $# -gt 0 ]; do if [ "$1" = -e ]; then sql="$2"; shift; fi; shift; done
case "$sql" in
  *information_schema.tables*)
    [ -n "$FAKE_FAIL_LIST" ] && { echo "ERROR 1045 access denied" >&2; exit 1; }
    printf 'users\t10\nbig_ticks\t5000000\nweird-name\t3\nfailing\t1\n';;
  *COUNT*users*) echo 11;;
  *COUNT*big_ticks*) echo 5000001;;
  *COUNT*failing*) echo "ERROR" >&2; exit 1;;
  *) echo "unexpected: $sql" >&2; exit 9;;
esac
`
	if err := os.WriteFile(dir+"/mysql", []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(mode string, failList bool) (string, error) {
		cmd := exec.Command("/bin/sh", "-c", mysqlVerifyBody("mysql"), "tugra-verify", "app", "appdb", mode, "1000000")
		cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin"}
		if failList {
			cmd.Env = append(cmd.Env, "FAKE_FAIL_LIST=1")
		}
		out, err := cmd.Output()
		return string(out), err
	}
	out, err := run("exact", false)
	if err != nil {
		t.Fatal(err)
	}
	got, perr := parseTableLines(out)
	if perr != nil {
		t.Fatalf("%v\n%s", perr, out)
	}
	want := []VerifyTable{{Name: "users", Rows: 11}, {Name: "big_ticks", Rows: 5000001}, {Name: "weird-name", Rows: -1}, {Name: "failing", Rows: -1}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("exact: got %+v want %+v", got, want)
	}
	out, err = run("estimate", false)
	if err != nil {
		t.Fatal(err)
	}
	got, _ = parseTableLines(out)
	if got[0] != (VerifyTable{Name: "users", Rows: 11}) || got[1] != (VerifyTable{Name: "big_ticks", Rows: 5000000, Estimated: true}) {
		t.Errorf("estimate mode counts small tables exactly and estimates the big one: %+v", got)
	}
	if _, err := run("exact", true); err == nil {
		t.Error("a failed table listing must fail the whole item, never report an empty success")
	}
}

// The same two literals are asserted in apps/hub-api/src/migration-runs/steps/data/verify/db-stats.spec.ts: the migrator
// measures the source with byte-for-byte the statements the hub runs on the target.
func TestVerifyStatementsMatchTheHub(t *testing.T) {
	const wantMysql = `T=$(printf '\t'); L=$(mysql -u"$1" --protocol=TCP -h127.0.0.1 -N -B -e "SELECT table_name, IFNULL(table_rows,0) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name" "$2") || exit 1; [ -n "$L" ] || exit 0; printf '%s\n' "$L" | while IFS="$T" read -r t est; do case "$t" in ''|*[!A-Za-z0-9_$]*) printf '%s\t-1\t0\n' "$t"; continue;; esac; if [ "$3" = estimate ] && [ "$est" -ge "$4" ]; then printf '%s\t%s\t1\n' "$t" "$est"; continue; fi; n=$(mysql -u"$1" --protocol=TCP -h127.0.0.1 -N -B -e "SELECT COUNT(*) FROM \` + "`" + `$t\` + "`" + `" "$2") || { printf '%s\t-1\t0\n' "$t"; continue; }; printf '%s\t%s\t0\n' "$t" "$n"; done`
	const wantPg = `SELECT n.nspname || '.' || c.relname, CASE WHEN c.reltuples >= 250000 THEN c.reltuples::bigint::text ELSE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text END, CASE WHEN c.reltuples >= 250000 THEN '1' ELSE '0' END FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%' ORDER BY 1`
	if got := mysqlVerifyBody("mysql"); got != wantMysql {
		t.Errorf("mysql body drifted from the hub's:\n%s", got)
	}
	if got := pgSQL(verifyModeEstimate, 250000); got != wantPg {
		t.Errorf("postgres estimate SQL drifted from the hub's:\n%s", got)
	}
}

func bigVerifyItem(ref string, tables int) VerifyItem {
	it := VerifyItem{ItemRef: ref, Engine: "POSTGRES", Kind: "tables", Mode: "exact", State: "measured", TableCount: tables}
	for i := 0; i < tables; i++ {
		it.Tables = append(it.Tables, VerifyTable{Name: fmt.Sprintf("public.some_reasonably_long_table_name_%05d", i), Rows: int64(1000 + i)})
	}
	return it
}

func TestPackVerifyItemsSplitsUnderTheBudgetAndTruncatesWhatCannotFit(t *testing.T) {
	const budget = 20 * 1024
	small := []VerifyItem{bigVerifyItem("database:_:a", 120), bigVerifyItem("database:_:b", 120), bigVerifyItem("database:_:c", 120), bigVerifyItem("database:_:d", 120)}
	batches, cut := packVerifyItems(small, budget)
	if cut != 0 || len(batches) < 2 {
		t.Fatalf("small items must be split across requests, not truncated: batches=%d cut=%d", len(batches), cut)
	}
	n := 0
	for _, b := range batches {
		if sz := jsonSize(verifyReq{Items: b}); sz > budget {
			t.Errorf("a batch is %d bytes, budget %d", sz, budget)
		}
		n += len(b)
	}
	if n != len(small) {
		t.Errorf("every item must be sent exactly once: %d of %d", n, len(small))
	}

	huge := bigVerifyItem("database:_:huge", 3000)
	batches, cut = packVerifyItems([]VerifyItem{small[0], huge}, budget)
	if cut != 1 {
		t.Fatalf("the oversize item must be counted as truncated: %d", cut)
	}
	var got VerifyItem
	for _, b := range batches {
		if sz := jsonSize(verifyReq{Items: b}); sz > budget {
			t.Errorf("a batch is %d bytes, budget %d", sz, budget)
		}
		for _, it := range b {
			if it.ItemRef == huge.ItemRef {
				got = it
			}
		}
	}
	if !got.Truncated || got.TableCount != 3000 || len(got.Tables) == 0 || len(got.Tables) >= 3000 {
		t.Errorf("a truncated item keeps its true table count and a prefix of its tables: truncated=%v count=%d kept=%d", got.Truncated, got.TableCount, len(got.Tables))
	}
	if got.Tables[0].Name != huge.Tables[0].Name {
		t.Error("the kept tables must be a prefix")
	}
}

func TestVerifyReportOfALargeFleetStaysUnderTheHubBodyLimit(t *testing.T) {
	hub := &verifyHub{targets: dbTargets, maxBody: 100 * 1024}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	var lines strings.Builder
	for i := 0; i < 3000; i++ {
		fmt.Fprintf(&lines, "public.some_reasonably_long_table_name_%05d\t%d\t0\n", i, 10+i)
	}
	d := &verifyDocker{out: map[string]string{pgID: lines.String(), otherID: "# Keyspace\r\ndb0:keys=7,expires=2,avg_ttl=5\r\n"}}
	d.install(t, []fakeContainer{
		{id: pgID, name: "mypg", image: "postgres:16", running: true, envv: []string{"POSTGRES_USER=app", "POSTGRES_PASSWORD=pgpw", "POSTGRES_DB=appdb"}},
		{id: otherID, name: "myrd", image: "redis:7", running: true, envv: []string{"REDIS_PASSWORD=rdpw"}},
		{id: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", name: "stopped", image: "postgres:16", running: false, envv: []string{"POSTGRES_PASSWORD=x"}},
	})
	out, _, stderr := runVerify(t, srv, "--arms", "volumes", "--verify", "--verify-mode", "exact", "--helper-image", "img:1")
	if out.Verify == nil || !out.Verify.Reported {
		t.Fatalf("a report over the hub's body limit must not be lost: %+v stderr=%s", out.Verify, stderr)
	}
	for _, n := range hub.bodies {
		if n > 100*1024 {
			t.Errorf("a request of %d bytes would be refused by the hub", n)
		}
	}
	byRef := map[string]VerifyItem{}
	for _, it := range hub.got {
		byRef[it.ItemRef] = it
	}
	if len(byRef) != 3 || byRef["database:_:myrd"].State != "measured" || byRef["database:_:stopped"].State != "skipped" {
		t.Errorf("every database must still arrive: %v", byRef)
	}
	pg := byRef["database:_:mypg"]
	if pg.State != "measured" || pg.TableCount != 3000 {
		t.Errorf("postgres item: state=%s count=%d", pg.State, pg.TableCount)
	}
}
