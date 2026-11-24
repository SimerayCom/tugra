package migrate

// DATABASE SIZE MEASUREMENT (`--dry-run`): what the hub needs to choose a lane per database.
//
// The 256 MiB artifact route is capped by the size of the DUMP (gzip), not the size of the volume: a volume a few MiB over
// the cap can still dump under it, and a database far under it can never exceed it. So the migrator measures, read-only:
//
//   - the catalog size of the database (pg_database_size / information_schema), a cheap statement, always; and
//   - for a database at or under --measure-dump-below (default 1 GiB, or any size with --measure-dump) the dump itself, run to
//     a counting sink (no spool, nothing written): the exact raw and gzip bytes the artifact route would have to carry.
//
// A bigger database is reported by its catalog size only: the hub treats it as over the cap (it is, to within a margin no
// database near the cap can hide in) and chooses the streamed lane. The numbers come from an untrusted host and are labelled
// that way; the hub uses them to ROUTE a database, never as proof that data arrived.
//
// Same boundary rules as the rest of the package: pinned no-shell argv built in Go, the password only as a bound
// `docker exec -e NAME` from the closed child env, validated user/db words, read-only statements.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Measured-by labels (the hub stores them with the numbers).
const (
	measuredByCatalog = "catalog"
	measuredByDump    = "dump"

	// defaultMeasureDumpBelow is the catalog size up to which the dump itself is counted (about a minute for a small DB).
	defaultMeasureDumpBelow int64 = 1 << 30
	// dbSizeMaxItems mirrors the hub's schema bound.
	dbSizeMaxItems = 500
)

// DbSizeItem is one database's measurement as the hub's strict schema takes it.
type DbSizeItem struct {
	ItemRef      string `json:"itemRef"`
	Engine       string `json:"engine"`
	State        string `json:"state"` // measured | failed | skipped
	Reason       string `json:"reason,omitempty"`
	DbBytes      int64  `json:"dbBytes"`
	DumpRawBytes *int64 `json:"dumpRawBytes,omitempty"`
	DumpGzBytes  *int64 `json:"dumpGzBytes,omitempty"`
	MeasuredBy   string `json:"measuredBy"`
	Ms           int64  `json:"ms,omitempty"`
}

type dbSizeReq struct {
	RunID string       `json:"runId"`
	Items []DbSizeItem `json:"items"`
}

// dumpEngines are the engines whose dump the streamed lane (and so this measurement) understands.
func isDumpEngine(engine string) bool {
	switch engine {
	case "POSTGRES", "MARIADB", "MYSQL", "MONGO", "CLICKHOUSE":
		return true
	}
	return false
}

// mysqlSizeBody is the constant in-container script for the MySQL family. $1 user, $2 database.
func mysqlSizeBody(client string) string {
	return client + ` -u"$1" --protocol=TCP -h127.0.0.1 -N -B -e "SELECT COALESCE(SUM(data_length+index_length),0) FROM information_schema.tables WHERE table_schema=DATABASE()" "$2"`
}

const pgSizeSQL = `SELECT pg_database_size(current_database())`

// buildSizePlan is BuildPlan's read-only sibling for the catalog size. Argv[0] is the docker path; no value in Argv is a
// secret; Env is the closed allowlist plus the one bound secret.
func buildSizePlan(engine string, c Creds, dockerPath string, lookup func(string) (string, bool)) (Plan, error) {
	if !isDumpEngine(engine) {
		return Plan{}, fmt.Errorf("engine %q has no size statement", engine)
	}
	if !validContainer(c.Ctr) {
		return Plan{}, &errInvalidCred{field: "container"}
	}
	if !validUser(c.User) {
		return Plan{}, &errInvalidCred{field: "user"}
	}
	if engine != "MONGO" && !validDB(c.DB) {
		return Plan{}, &errInvalidCred{field: "db"}
	}
	bind, _ := verifyBind(engine)
	var argv []string
	switch engine {
	case "MONGO", "CLICKHOUSE":
		if !validConfigPassword(c.PW) {
			return Plan{}, &errInvalidCred{field: "password"}
		}
		if engine == "MONGO" {
			argv = []string{dockerPath, "exec", "-e", dbPwEnv, c.Ctr, "sh", "-c", mongoShellBody, "tugra-size", c.User, "exact", "1", mongoSizeJS}
		} else {
			if !validPlainDB(c.DB) {
				return Plan{}, &errInvalidCred{field: "db"}
			}
			argv = []string{dockerPath, "exec", "-e", dbPwEnv, c.Ctr, "sh", "-c", chSizeBody, "tugra-size", c.User, c.DB}
		}
	case "POSTGRES":
		argv = []string{dockerPath, "exec", "-e", "PGPASSWORD", c.Ctr, "psql", "-X", "-q", "-A", "-t", "-U", c.User, "-d", c.DB, "-c", pgSizeSQL}
	case "MYSQL":
		argv = []string{dockerPath, "exec", "-e", "MYSQL_PWD", c.Ctr, "sh", "-c", mysqlSizeBody("mysql"), "tugra-size", c.User, c.DB}
	case "MARIADB":
		argv = []string{dockerPath, "exec", "-e", "MYSQL_PWD", c.Ctr, "sh", "-c", mysqlSizeBody("mariadb"), "tugra-size", c.User, c.DB}
	}
	env := map[string]string{}
	for _, name := range childEnvAllowlist {
		if v, ok := lookup(name); ok && v != "" && !strings.ContainsRune(v, 0) {
			env[name] = v
		}
	}
	if _, ok := env["PATH"]; !ok {
		env["PATH"] = defaultPath
	}
	if c.HasPW && c.PW != "" && !strings.ContainsRune(c.PW, 0) {
		if _, dup := env[bind.Name]; dup {
			return Plan{}, fmt.Errorf("bind name %s collides with an allowlisted var", bind.Name)
		}
		env[bind.Name] = c.PW
	}
	return Plan{Argv: argv, Env: flattenEnv(env), Engine: engine, Container: c.Ctr}, nil
}

var errSizeUnparseable = errors.New("size output is not a single non-negative integer")

// parseSizeOutput accepts exactly one integer line (the engines print nothing else with -A -t / -N -B).
func parseSizeOutput(out string) (int64, error) {
	var lines []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) != 1 {
		return 0, errSizeUnparseable
	}
	n, err := strconv.ParseInt(lines[0], 10, 64)
	if err != nil || n < 0 {
		return 0, errSizeUnparseable
	}
	return n, nil
}

// PutDbSizes reports the measurements to the hub (token route, strict schema).
func (h *Hub) PutDbSizes(ctx context.Context, runID string, items []DbSizeItem) error {
	var r VxExpiry
	if err := h.doBody(ctx, http.MethodPost, vxPrefix+"db-sizes", dbSizeReq{RunID: runID, Items: items}, &r, 4, 0); err != nil {
		return err
	}
	h.noteExpiry(r)
	return nil
}

// measureOne measures one database. It never aborts the run: a problem is an item state with a fixed reason.
func (r *runner) measureOne(ctx context.Context, tg Target) DbSizeItem {
	it := DbSizeItem{ItemRef: tg.ItemRef, Engine: tg.Engine, MeasuredBy: measuredByCatalog}
	fail := func(state, reason string) DbSizeItem {
		it.State, it.Reason = state, reason
		return it
	}
	src, derr := Resolve(ctx, tg, r.overrides[tg.ItemRef], r.dockerPath, r.dockerEnv)
	if derr != nil {
		switch {
		case errors.Is(derr, ErrNotRunning):
			return fail("skipped", "not-running")
		case errors.Is(derr, ErrNotFound):
			return fail("skipped", "unresolved")
		default:
			_, reason := discoverOutcome(derr)
			return fail("failed", reason)
		}
	}
	rc, sk := resolveCreds(tg.Engine, src.inspect)
	if sk != nil {
		return fail("skipped", sk.reason)
	}
	r.sc.add(rc.pw)
	r.sc.add(rc.user)
	r.sc.add(rc.db)
	creds := Creds{Ctr: src.ID, User: rc.user, DB: rc.db, PW: rc.pw, HasPW: rc.pw != ""}

	started := time.Now()
	splan, berr := buildSizePlan(tg.Engine, creds, r.dockerPath, os.LookupEnv)
	if berr != nil {
		return fail("failed", "invalid-name")
	}
	sctx, scancel := context.WithTimeout(ctx, 2*time.Minute)
	stdout, stderr, err := runDocker(sctx, splan.Argv, splan.Env)
	scancel()
	if err != nil {
		if ctx.Err() != nil {
			return fail("failed", "interrupted")
		}
		r.logf("size %s: %v (%s)", tg.ItemRef, err, firstLine(stderr))
		return fail("failed", "size-exec")
	}
	n, perr := parseSizeOutput(string(stdout))
	if perr != nil {
		return fail("failed", "size-parse")
	}
	it.DbBytes = n

	// The dump itself, counted and discarded, when it is cheap enough (or the operator asked for it at any size).
	if (r.c.measureDump || n <= r.c.measureDumpBelow) && r.parsed[tg.Engine] != nil {
		dplan, derr2 := BuildPlan(r.parsed[tg.Engine], creds, r.dockerPath, os.LookupEnv)
		if derr2 == nil {
			ds, merr := MeasureDump(ctx, dplan, r.c.dumpTimeout)
			cleanupDumpLeftovers(tg.Engine, src.ID, r.dockerPath, r.dockerEnv)
			switch {
			case merr == nil:
				raw, gz := ds.RawBytes, ds.GzBytes
				it.DumpRawBytes, it.DumpGzBytes, it.MeasuredBy = &raw, &gz, measuredByDump
			case ctx.Err() != nil:
				return fail("failed", "interrupted")
			default:
				// The catalog size stands; the hub treats an unmeasured dump near the cap as over it (fail closed).
				r.logf("dump measure %s: %v", tg.ItemRef, merr)
			}
		}
	}
	it.State = "measured"
	it.Ms = time.Since(started).Milliseconds()
	return it
}

// dbSizePhase measures every in-scope dump-capable database and reports the lot to the hub. It returns the measurements keyed
// by itemRef (the streamed lane's dry run reads them) and a non-zero abort code only on lost authentication.
func dbSizePhase(ctx context.Context, run *runner, scope []Target, runID string) (map[string]DbSizeItem, int) {
	out := map[string]DbSizeItem{}
	var items []DbSizeItem
	for _, tg := range scope {
		if ctx.Err() != nil {
			break
		}
		if !isDumpEngine(tg.Engine) || tg.DataPlane == "unsupported" {
			continue
		}
		run.logf("measure %s %s", tg.ItemRef, tg.Engine)
		it := run.measureOne(ctx, tg)
		out[tg.ItemRef] = it
		items = append(items, it)
		if len(items) >= dbSizeMaxItems {
			break
		}
	}
	if len(items) == 0 {
		return out, 0
	}
	rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	err := run.hub.PutDbSizes(rctx, runID, items)
	cancel()
	if err != nil {
		if a := abortKind(err); a != 0 {
			return out, a
		}
		run.logf("db size report failed: %v", err)
	}
	return out, 0
}

// sortedDbSizes lists the measurements in a stable order (the run's one JSON line is diffed by humans and tests).
func sortedDbSizes(m map[string]DbSizeItem) []DbSizeItem {
	out := make([]DbSizeItem, 0, len(m))
	for _, it := range m {
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ItemRef < out[j].ItemRef })
	return out
}

// validateDumpFlags rejects out-of-range measurement flags before any network call (exit 2).
func (c *cli) validateDumpFlags() error {
	if c.measureDumpBelow < 0 || c.measureDumpBelow > 1<<40 {
		return fmt.Errorf("--measure-dump-below must be between 0 and 1 TiB")
	}
	if c.dumpSpoolMiB != 0 && (c.dumpSpoolMiB < 1 || c.dumpSpoolMiB > 4<<20) {
		return fmt.Errorf("--dump-spool-mib must be between 1 and 4194304 (4 TiB)")
	}
	if c.dumpSpoolDir != "" && !isCleanAbs(c.dumpSpoolDir) {
		return fmt.Errorf("--dump-spool-dir must be a clean absolute path")
	}
	return nil
}
