package migrate

// The `--verify` phase: DB LOGICAL PARITY evidence for a guided migration run (P7).
//
// Bytes, sha256 and entry counts (the volume arm) prove a COPY is intact; they do not prove that the restored database
// holds the same rows. After the data arms, `--verify` measures the SOURCE side of that comparison: Redis-family key
// counts per logical db, and Postgres/MySQL/MariaDB per-table row counts. It POSTs them to the hub, which stores them as
// `migrator-reported` evidence and measures the TARGET side itself (through the target agent). The hub never trusts these
// numbers beyond that label: they come from an untrusted host.
//
// Same boundary rules as the dump arm (see doc.go):
//
//   - Read-only: only SELECT/INFO. Nothing is written, stopped or removed.
//   - The password is NEVER on an argv. It travels only as a bound `docker exec -e NAME` sourced from the child env, which
//     is the closed allowlist (never os.Environ(), so the migration token cannot reach a client).
//   - Every command is built IN GO from a pinned template and run WITHOUT a host shell. The two in-container `sh -c` bodies
//     are constants; the validated user/db names and the mode travel as positional parameters, never spliced into text.
//   - Fail closed and explicit: a container that is stopped, an engine we cannot prove, an unparseable answer is reported
//     with a fixed reason (never an empty "all good"), and the hub treats anything not measured as UNKNOWN.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Verify modes. `exact` runs count(*) on every table; `estimate` uses the planner's row estimate for tables at or above
// the threshold (the answer says so per table, and the hub compares those with a tolerance, never as exact).
const (
	verifyModeExact    = "exact"
	verifyModeEstimate = "estimate"

	// defaultVerifyExactBelow is the row estimate under which `estimate` mode still counts exactly.
	defaultVerifyExactBelow = 1_000_000
	// maxVerifyTables bounds one item's report (the hub's schema caps it identically).
	maxVerifyTables = 5000
	verifyTab       = "\t"
)

// VerifyTable is one measured relation: a table (rows) or a Redis logical db (keys, with how many carry a TTL).
// Rows == -1 means "not counted" (an exotic table name the in-container loop refuses to interpolate, or a failed count).
type VerifyTable struct {
	Name      string `json:"name"`
	Rows      int64  `json:"rows"`
	Estimated bool   `json:"estimated,omitempty"`
	Expires   int64  `json:"expires,omitempty"`
}

// VerifyItem is the source-side measurement of one database.
type VerifyItem struct {
	ItemRef    string        `json:"itemRef"`
	Engine     string        `json:"engine"`
	Kind       string        `json:"kind"`  // "tables" | "keys"
	Mode       string        `json:"mode"`  // exact | estimate
	State      string        `json:"state"` // measured | skipped | failed
	Reason     string        `json:"reason,omitempty"`
	TableCount int           `json:"tableCount"`
	Truncated  bool          `json:"truncated,omitempty"`
	Tables     []VerifyTable `json:"tables"`
}

type verifyReq struct {
	Items []VerifyItem `json:"items"`
}

// VerifyResp is the hub's receipt.
type VerifyResp struct {
	Stored int `json:"stored"`
}

// verifyOut is the `verify` object of the final JSON line (present only when --verify was set).
type verifyOut struct {
	Reported bool         `json:"reported"`
	Measured int          `json:"measured"`
	Skipped  int          `json:"skipped"`
	Failed   int          `json:"failed"`
	Items    []VerifyItem `json:"items"`
}

// PutVerify reports the source-side measurements to the hub (a token-authenticated POST; retried like every other
// control-plane call).
func (h *Hub) PutVerify(ctx context.Context, items []VerifyItem) (*VerifyResp, error) {
	var r VerifyResp
	if err := h.doBody(ctx, "POST", "verify", verifyReq{Items: items}, &r, 4, 0); err != nil {
		return nil, err
	}
	return &r, nil
}

// ---- the pinned statements --------------------------------------------------------------------------------------

// pgCountExpr counts one relation's rows by evaluating a generated statement (the standard query_to_xml technique): the
// only way to count every table with ONE read-only statement and no per-table client round trip.
const pgCountExpr = `(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text`

const pgRelations = ` FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace` +
	` WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema')` +
	` AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%' ORDER BY 1`

// pgSQL returns the statement for a mode. below is only used (and only embedded, as a validated integer) in estimate mode.
func pgSQL(mode string, below int64) string {
	if mode == verifyModeExact {
		return `SELECT n.nspname || '.' || c.relname, ` + pgCountExpr + `, '0'` + pgRelations
	}
	b := strconv.FormatInt(below, 10)
	return `SELECT n.nspname || '.' || c.relname, CASE WHEN c.reltuples >= ` + b + ` THEN c.reltuples::bigint::text ELSE ` + pgCountExpr +
		` END, CASE WHEN c.reltuples >= ` + b + ` THEN '1' ELSE '0' END` + pgRelations
}

// mysqlVerifyBody is the constant in-container script for MySQL (client "mysql") and MariaDB (client "mariadb").
// Positional parameters: $1 user, $2 database, $3 mode, $4 threshold. A table name that is not a plain identifier is
// reported uncounted (-1) instead of being interpolated into SQL.
func mysqlVerifyBody(client string) string {
	c := client + ` -u"$1" --protocol=TCP -h127.0.0.1 -N -B`
	return `T=$(printf '\t'); ` +
		`L=$(` + c + ` -e "SELECT table_name, IFNULL(table_rows,0) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name" "$2") || exit 1; ` +
		`[ -n "$L" ] || exit 0; ` +
		`printf '%s\n' "$L" | while IFS="$T" read -r t est; do ` +
		`case "$t" in ''|*[!A-Za-z0-9_$]*) printf '%s\t-1\t0\n' "$t"; continue;; esac; ` +
		`if [ "$3" = estimate ] && [ "$est" -ge "$4" ]; then printf '%s\t%s\t1\n' "$t" "$est"; continue; fi; ` +
		`n=$(` + c + ` -e "SELECT COUNT(*) FROM \` + "`" + `$t\` + "`" + `" "$2") || { printf '%s\t-1\t0\n' "$t"; continue; }; ` +
		`printf '%s\t%s\t0\n' "$t" "$n"; done`
}

// ---- plan -----------------------------------------------------------------------------------------------------

// verifyKind is "keys" for the redis family, else "tables".
func verifyKind(engine string) string {
	switch engine {
	case "REDIS", "KEYDB", "DRAGONFLY":
		return "keys"
	default:
		return "tables"
	}
}

func verifyBind(engine string) (Bind, bool) {
	switch engine {
	case "POSTGRES":
		return Bind{Name: "PGPASSWORD", From: "pw"}, true
	case "MYSQL", "MARIADB":
		return Bind{Name: "MYSQL_PWD", From: "pw"}, true
	case "REDIS", "KEYDB", "DRAGONFLY":
		return Bind{Name: "REDISCLI_AUTH", From: "pw"}, true
	}
	return Bind{}, false
}

// buildVerifyPlan is BuildPlan's read-only sibling: a ready-to-exec statistics command for one DB. Argv[0] is the docker
// path; no value in Argv is a secret; Env is the closed allowlist plus the one bound secret.
func buildVerifyPlan(engine string, c Creds, mode string, below int64, dockerPath string, lookup func(string) (string, bool)) (Plan, error) {
	bind, ok := verifyBind(engine)
	if !ok {
		return Plan{}, fmt.Errorf("engine %q has no verify statement", engine)
	}
	if mode != verifyModeExact && mode != verifyModeEstimate {
		return Plan{}, fmt.Errorf("bad verify mode")
	}
	if below < 1 || below > 1_000_000_000_000 {
		return Plan{}, fmt.Errorf("bad verify threshold")
	}
	if !validContainer(c.Ctr) {
		return Plan{}, &errInvalidCred{field: "container"}
	}
	var argv []string
	switch engine {
	case "POSTGRES":
		if !validUser(c.User) {
			return Plan{}, &errInvalidCred{field: "user"}
		}
		if !validDB(c.DB) {
			return Plan{}, &errInvalidCred{field: "db"}
		}
		argv = []string{dockerPath, "exec", "-e", "PGPASSWORD", c.Ctr, "psql", "-X", "-q", "-A", "-t", "-F", verifyTab, "-v", "ON_ERROR_STOP=1", "-U", c.User, "-d", c.DB, "-c", pgSQL(mode, below)}
	case "MYSQL", "MARIADB":
		if !validUser(c.User) {
			return Plan{}, &errInvalidCred{field: "user"}
		}
		if !validDB(c.DB) {
			return Plan{}, &errInvalidCred{field: "db"}
		}
		client := "mysql"
		if engine == "MARIADB" {
			client = "mariadb"
		}
		argv = []string{dockerPath, "exec", "-e", "MYSQL_PWD", c.Ctr, "sh", "-c", mysqlVerifyBody(client), "tugra-verify", c.User, c.DB, mode, strconv.FormatInt(below, 10)}
	case "REDIS":
		argv = []string{dockerPath, "exec", "-e", "REDISCLI_AUTH", c.Ctr, "redis-cli", "--no-auth-warning", "INFO", "keyspace"}
	case "KEYDB":
		argv = []string{dockerPath, "exec", "-e", "REDISCLI_AUTH", c.Ctr, "keydb-cli", "--no-auth-warning", "INFO", "keyspace"}
	case "DRAGONFLY":
		argv = []string{dockerPath, "exec", "-e", "REDISCLI_AUTH", c.Ctr, "redis-cli", "--no-auth-warning", "INFO", "keyspace"}
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

// ---- parsing --------------------------------------------------------------------------------------------------

var (
	errVerifyUnparseable = errors.New("verify output is not in the expected shape")
	errVerifyNoKeyspace  = errors.New("no keyspace section in the answer (authentication failed?)")
)

// parseTableLines parses `name<TAB>rows<TAB>estimated` lines. Any malformed line fails the WHOLE item: a half-read answer
// must never be reported as a clean count.
func parseTableLines(out string) ([]VerifyTable, error) {
	var tables []VerifyTable
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		f := strings.Split(line, verifyTab)
		if len(f) != 3 || f[0] == "" || len(f[0]) > 300 {
			return nil, errVerifyUnparseable
		}
		rows, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil || rows < -1 {
			return nil, errVerifyUnparseable
		}
		switch f[2] {
		case "0", "1":
		default:
			return nil, errVerifyUnparseable
		}
		tables = append(tables, VerifyTable{Name: stripControl(f[0]), Rows: rows, Estimated: f[2] == "1"})
	}
	return tables, nil
}

// parseKeyspace parses `INFO keyspace`: a `# Keyspace` header then `dbN:keys=K,expires=E,avg_ttl=T` lines. The header is
// REQUIRED: a NOAUTH/WRONGPASS reply makes redis-cli exit 0 with an error line, which is not an empty keyspace.
func parseKeyspace(out string) ([]VerifyTable, error) {
	seen := false
	var tables []VerifyTable
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(strings.TrimRight(line, "\r"))
		switch {
		case line == "":
		case strings.HasPrefix(line, "# Keyspace"):
			seen = true
		case strings.HasPrefix(line, "db"):
			name, rest, ok := strings.Cut(line, ":")
			if !ok || !isDBName(name) {
				return nil, errVerifyUnparseable
			}
			t := VerifyTable{Name: name, Rows: -1}
			for _, kv := range strings.Split(rest, ",") {
				k, v, ok := strings.Cut(kv, "=")
				if !ok {
					continue
				}
				switch k {
				case "keys":
					n, err := strconv.ParseInt(v, 10, 64)
					if err != nil || n < 0 {
						return nil, errVerifyUnparseable
					}
					t.Rows = n
				case "expires":
					if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
						t.Expires = n
					}
				}
			}
			if t.Rows < 0 {
				return nil, errVerifyUnparseable
			}
			tables = append(tables, t)
		default:
			// Any other line (an error text, a stray warning) means this is not a clean INFO answer.
			return nil, errVerifyUnparseable
		}
	}
	if !seen {
		return nil, errVerifyNoKeyspace
	}
	return tables, nil
}

func isDBName(s string) bool {
	if len(s) < 3 || len(s) > 8 || !strings.HasPrefix(s, "db") {
		return false
	}
	for _, r := range s[2:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ---- orchestration --------------------------------------------------------------------------------------------

// verifyOne measures one database. It never returns an abort code: a verify problem is an item state, not a run abort
// (only a hub auth failure when REPORTING aborts, handled by the caller).
func (r *runner) verifyOne(ctx context.Context, tg Target) VerifyItem {
	it := VerifyItem{ItemRef: tg.ItemRef, Engine: tg.Engine, Kind: verifyKind(tg.Engine), Mode: r.c.verifyMode, Tables: []VerifyTable{}}
	skip := func(state, reason string) VerifyItem {
		it.State, it.Reason = state, reason
		return it
	}
	if tg.DataPlane == "unsupported" {
		return skip("skipped", "unsupported")
	}
	if _, ok := verifyBind(tg.Engine); !ok {
		return skip("skipped", "no-verify")
	}
	src, derr := Resolve(ctx, tg, r.overrides[tg.ItemRef], r.dockerPath, r.dockerEnv)
	if derr != nil {
		switch {
		case errors.Is(derr, ErrNotRunning):
			// A physically-copied (volume-mode) database is stopped by design: its parity evidence is the volume arm's.
			return skip("skipped", "not-running")
		case errors.Is(derr, ErrNotFound):
			return skip("skipped", "unresolved")
		default:
			_, reason := discoverOutcome(derr)
			return skip("failed", reason)
		}
	}
	rc, sk := resolveCreds(tg.Engine, src.inspect)
	if sk != nil {
		return skip("skipped", sk.reason)
	}
	r.sc.add(rc.pw)
	r.sc.add(rc.user)
	r.sc.add(rc.db)
	plan, berr := buildVerifyPlan(tg.Engine, Creds{Ctr: src.ID, User: rc.user, DB: rc.db, PW: rc.pw, HasPW: rc.pw != ""}, r.c.verifyMode, r.c.verifyExactBelow, r.dockerPath, os.LookupEnv)
	if berr != nil {
		return skip("failed", "invalid-name")
	}
	tctx, cancel := context.WithTimeout(ctx, r.c.dumpTimeout)
	stdout, stderr, err := runDocker(tctx, plan.Argv, plan.Env)
	cancel()
	if err != nil {
		if ctx.Err() != nil {
			return skip("failed", "interrupted")
		}
		r.logf("verify %s: %v (%s)", tg.ItemRef, err, firstLine(stderr))
		return skip("failed", "verify-exec")
	}
	var tables []VerifyTable
	var perr error
	if it.Kind == "keys" {
		tables, perr = parseKeyspace(string(stdout))
	} else {
		tables, perr = parseTableLines(string(stdout))
	}
	if perr != nil {
		return skip("failed", "verify-parse")
	}
	it.TableCount = len(tables)
	if len(tables) > maxVerifyTables {
		tables = tables[:maxVerifyTables]
		it.Truncated = true
	}
	it.Tables = tables
	it.State = "measured"
	return it
}

// verifyPhase measures the source side of every in-scope database and reports it to the hub. It returns the (possibly
// replaced) exit code: a hub auth/unreachable failure replaces it; any non-measured item downgrades a clean run to partial.
func verifyPhase(ctx context.Context, run *runner, scope []Target, out *output, code int) int {
	vo := &verifyOut{Items: []VerifyItem{}}
	out.Verify = vo
	for _, tg := range scope {
		if ctx.Err() != nil {
			break
		}
		run.logf("verify %s %s", tg.ItemRef, tg.Engine)
		it := run.verifyOne(ctx, tg)
		vo.Items = append(vo.Items, it)
		switch it.State {
		case "measured":
			vo.Measured++
		case "skipped":
			vo.Skipped++
		default:
			vo.Failed++
		}
	}
	if len(vo.Items) == 0 {
		return code
	}
	rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	_, err := run.hub.PutVerify(rctx, vo.Items)
	cancel()
	if err != nil {
		if a := abortKind(err); a != 0 {
			run.logf("verify report failed: %s", codeName(a))
			return a
		}
		run.logf("verify report failed: %v", err)
		if code == exitOK {
			return exitPartial
		}
		return code
	}
	vo.Reported = true
	if (vo.Skipped > 0 || vo.Failed > 0) && code == exitOK {
		return exitPartial
	}
	return code
}

// validateVerifyFlags rejects out-of-range verify flags before any network call (exit 2).
func (c *cli) validateVerifyFlags() error {
	switch c.verifyMode {
	case verifyModeExact, verifyModeEstimate:
	default:
		return fmt.Errorf("--verify-mode must be exact or estimate")
	}
	if c.verifyExactBelow < 1 || c.verifyExactBelow > 1_000_000_000_000 {
		return fmt.Errorf("--verify-exact-below must be between 1 and 1e12")
	}
	return nil
}
