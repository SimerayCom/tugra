//go:build dockerit

package migrate

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Real-docker gate for MongoDB and ClickHouse (needs `mongo:7` and `clickhouse/clickhouse-server:24.8` locally): a source container with a
// hostile password is dumped with the REAL recipe (credentials discovered through `docker inspect`, the password only as a bound env),
// restored into a second container with different credentials (and, for ClickHouse, a different database name) through the restore
// body, and the per-collection / per-table counts of both sides are compared with the very statements `--verify` runs.
func itDocker(t *testing.T, image string) string {
	t.Helper()
	p, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("docker not available")
	}
	if err := exec.Command(p, "image", "inspect", image).Run(); err != nil {
		t.Skipf("image %s not present", image)
	}
	return p
}

func itRun(t *testing.T, docker string, stdin io.Reader, env []string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, docker, args...)
	cmd.Stdin = stdin
	if env != nil {
		cmd.Env = env
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("docker %v: %v\n%s", args[:min(4, len(args))], err, out.String())
	}
	return strings.TrimSpace(out.String())
}

func itWait(t *testing.T, fn func() bool) {
	t.Helper()
	for i := 0; i < 60; i++ {
		if fn() {
			return
		}
		time.Sleep(2 * time.Second)
	}
	t.Fatal("the database never became ready")
}

// dumpRestoreVerify runs the whole chain for one engine and returns the (source, target) statistics.
func dumpRestoreVerify(t *testing.T, docker, engine, srcName, dstName string, dstCreds Creds, restoreBody string, restoreArgs []string) (src, dst []VerifyTable) {
	t.Helper()
	env := dockerBaseEnv(os.LookupEnv)
	ctx := context.Background()
	source, err := Resolve(ctx, Target{ItemRef: "database:_:it", Kind: "database", Engine: engine}, srcName, docker, env)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	rc, sk := resolveCreds(engine, source.inspect)
	if sk != nil {
		t.Fatalf("creds: %v", sk.reason)
	}
	spec := engineSpecs[engine]
	parsed, err := ParseRecipe(engine, Recipe{Command: spec.golden, Format: spec.format, Env: []Bind{spec.bind}})
	if err != nil {
		t.Fatal(err)
	}
	creds := Creds{Ctr: source.ID, User: rc.user, DB: rc.db, PW: rc.pw, HasPW: true}
	plan, err := BuildPlan(parsed, creds, docker, os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	// the password is never on any argv word
	for _, a := range plan.Argv {
		if strings.Contains(a, rc.pw) {
			t.Fatalf("the password is on the argv: %q", a)
		}
	}
	defer cleanupDumpLeftovers(engine, source.ID, docker, env)
	stdout, wait, err := startDumpFn(ctx, plan)
	if err != nil {
		t.Fatal(err)
	}
	dump, err := io.ReadAll(&sanityReader{r: stdout, engine: engine})
	if err != nil {
		t.Fatalf("dump read: %v", err)
	}
	if err := wait(); err != nil {
		t.Fatalf("dump: %v", err)
	}
	if len(dump) < 100 {
		t.Fatalf("a dump of %d bytes", len(dump))
	}

	// restore into the second container: the password in the environment of the docker client, the body from the shared script
	renv := append(dockerBaseEnv(os.LookupEnv), dbPwEnv+"="+dstCreds.PW)
	itRun(t, docker, bytes.NewReader(dump), renv, append([]string{"exec", "-i", "-e", dbPwEnv, dstName, "sh", "-c", restoreBody, "tugra-it"}, restoreArgs...)...)

	stat := func(c Creds) []VerifyTable {
		vp, err := buildVerifyPlan(engine, c, verifyModeExact, 1_000_000, docker, os.LookupEnv)
		if err != nil {
			t.Fatal(err)
		}
		out, errText, err := runDocker(ctx, vp.Argv, vp.Env)
		if err != nil {
			t.Fatalf("verify: %v %s", err, errText)
		}
		tables, perr := parseTableLines(string(out))
		if perr != nil {
			t.Fatalf("verify output: %v\n%s", perr, out)
		}
		return tables
	}
	return stat(creds), stat(Creds{Ctr: dstName, User: dstCreds.User, DB: dstCreds.DB, PW: dstCreds.PW, HasPW: true})
}

func TestDockerITMongoRoundTripWithAHostilePassword(t *testing.T) {
	docker := itDocker(t, "mongo:7")
	sfx := shortRun(newRunID())
	srcPW, dstPW := `p"a\ss$x&<>'`+"`", `Zq"7\k$&<`
	src, dst := "itdb_mongo_src_"+sfx, "itdb_mongo_dst_"+sfx
	for _, c := range []struct{ name, user, pw string }{{src, "root", srcPW}, {dst, "tgt", dstPW}} {
		itRun(t, docker, nil, nil, "run", "-d", "--name", c.name, "-e", "MONGO_INITDB_ROOT_USERNAME="+c.user, "-e", "MONGO_INITDB_ROOT_PASSWORD="+c.pw, "mongo:7")
		defer exec.Command(docker, "rm", "-f", c.name).Run()
	}
	seed := `var a=db.getSiblingDB("admin");a.auth(process.env.U,process.env.P);var s=db.getSiblingDB("shop");s.items.insertMany(Array.from({length:500},function(_,i){return{i:i}}));s.users.insertOne({n:1});db.getSiblingDB("blog").posts.insertMany([{a:1},{a:2},{a:3}]);`
	itWait(t, func() bool {
		return exec.Command(docker, "exec", "-e", "U=root", "-e", "P="+srcPW, src, "mongosh", "--quiet", "--eval", seed).Run() == nil
	})
	itWait(t, func() bool {
		return exec.Command(docker, "exec", "-e", "U=tgt", "-e", "P="+dstPW, dst, "mongosh", "--quiet", "--eval", `var a=db.getSiblingDB("admin");a.auth(process.env.U,process.env.P);a.runCommand({ping:1})`).Run() == nil
	})
	s, d := dumpRestoreVerify(t, docker, "MONGO", src, dst, Creds{User: "tgt", PW: dstPW}, mongoRestoreBody, []string{"tgt"})
	want := map[string]int64{"blog.posts": 3, "shop.items": 500, "shop.users": 1}
	for _, side := range [][]VerifyTable{s, d} {
		got := map[string]int64{}
		for _, tb := range side {
			got[tb.Name] = tb.Rows
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s: %d documents, want %d (side %v)", k, got[k], v, got)
			}
		}
	}
}

func TestDockerITClickHouseRoundTripIntoADifferentlyNamedDatabase(t *testing.T) {
	docker := itDocker(t, "clickhouse/clickhouse-server:24.8")
	sfx := shortRun(newRunID())
	srcPW, dstPW := `p"a\ss$x&<>`, `Zq"7\k$&<`
	src, dst := "itdb_ch_src_"+sfx, "itdb_ch_dst_"+sfx
	itRun(t, docker, nil, nil, "run", "-d", "--name", src, "-e", "CLICKHOUSE_USER=chu", "-e", "CLICKHOUSE_PASSWORD="+srcPW, "-e", "CLICKHOUSE_DB=appdb", "clickhouse/clickhouse-server:24.8")
	defer exec.Command(docker, "rm", "-f", src).Run()
	itRun(t, docker, nil, nil, "run", "-d", "--name", dst, "-e", "CLICKHOUSE_USER=tgu", "-e", "CLICKHOUSE_PASSWORD="+dstPW, "-e", "CLICKHOUSE_DB=otherdb", "clickhouse/clickhouse-server:24.8")
	defer exec.Command(docker, "rm", "-f", dst).Run()
	ch := func(name, user, pw, q string) bool {
		return exec.Command(docker, "exec", name, "clickhouse-client", "--user", user, "--password", pw, "--multiquery", "--query", q).Run() == nil
	}
	itWait(t, func() bool {
		return ch(src, "chu", srcPW, "CREATE TABLE IF NOT EXISTS appdb.t1 (a UInt32) ENGINE=MergeTree ORDER BY a; INSERT INTO appdb.t1 SELECT number FROM numbers(1000); CREATE TABLE IF NOT EXISTS appdb.t2 (x Int8) ENGINE=Log; INSERT INTO appdb.t2 VALUES (1),(2)")
	})
	itWait(t, func() bool { return ch(dst, "tgu", dstPW, "SELECT 1") })
	s, d := dumpRestoreVerify(t, docker, "CLICKHOUSE", src, dst, Creds{User: "tgu", DB: "otherdb", PW: dstPW}, chRestoreBody, []string{"tgu", "otherdb"})
	for name, side := range map[string][]VerifyTable{"source": s, "target": d} {
		got := map[string]int64{}
		for _, tb := range side {
			got[tb.Name] = tb.Rows
		}
		if got["t1"] != 1000 || got["t2"] != 2 {
			t.Errorf("%s counts: %v", name, got)
		}
	}
}
