package migrate

import (
	"fmt"
	"regexp"
	"strings"
)

// SupportedRecipesV is the ONLY recipe-contract version this binary understands. The hub's
// GET /recipes returns {v:1,...} (apps/hub-api/src/importer/migration-ingest.service.ts). A
// different v means a changed contract (new field semantics / quoting / binding kind) this
// binary cannot honor safely in either direction, so it fails closed with a skew error.
const SupportedRecipesV = 1

// Bind is one `docker exec -e NAME` forwarding: the migrator sets NAME in the dump child's
// env from the locally-resolved credential field `From`. Mirrors RecipeEnvBind in
// apps/hub-api/src/importer/migrator-recipe.ts.
type Bind struct {
	Name string `json:"name"`
	From string `json:"from"` // "user" | "pw" | "db"
}

// Recipe is one engine's served dump recipe, exactly as GET /recipes serves it.
type Recipe struct {
	Command  string `json:"command"`
	Format   string `json:"format"`
	PgFormat string `json:"pgFormat,omitempty"`
	Env      []Bind `json:"env"`
}

// RecipesEnvelope is the GET /recipes response. Decoded with DisallowUnknownFields so a hub
// that adds a field WITHOUT bumping v fails closed rather than being silently half-honored.
type RecipesEnvelope struct {
	V           int               `json:"v"`
	Recipes     map[string]Recipe `json:"recipes"`
	Unsupported map[string]string `json:"unsupported"`
}

// Creds are the locally-resolved (via `docker inspect`) credentials for one source DB. The
// password is bound into the child env, never an argv; user/db are validated argv words.
type Creds struct {
	Ctr   string // the immutable 64-hex container ID discover.go resolved (becomes TUGRA_SRC_CTR)
	User  string
	DB    string
	PW    string
	HasPW bool
}

// Plan is the fully-resolved, ready-to-exec dump for one item. Argv[0] is the absolute docker
// path; no value in Argv is a secret. Env is the complete child env (never nil: a nil Env means
// "inherit os.Environ()" in Go, which would leak the migrator's whole environment).
type Plan struct {
	Argv      []string
	Env       []string
	Engine    string
	Container string
	Format    string // pg_custom | sql | rdb — what the hub restore consumes
	PgFormat  string // "custom" for POSTGRES, else ""
}

// engineSpec is the compiled-in, pinned contract for one streamable engine. The golden command
// is the EXACT string the hub must serve (a drift tripwire); argv is built in Go from the
// template, not by parsing the hub string. tool* describe which credential fields the recipe
// actually consumes so BuildPlan validates/exports exactly those and no more.
type engineSpec struct {
	golden   string                     // byte-exact expected recipe.command (the $TUGRA_SRC_* template)
	format   string                     // expected recipe.format
	pgFormat string                     // expected recipe.pgFormat ("" for non-POSTGRES)
	bind     Bind                       // the single expected env bind
	usesUser bool                       // command references $TUGRA_SRC_USER
	usesDB   bool                       // command references $TUGRA_SRC_DB
	argv     func(c Creds) []string     // the Go-native argv template (docker ... with values substituted)
}

// redisBody renders the in-container `sh -c` body for a redis-family SAVE dump. It is ONE argv
// token and carries no credential and no $TUGRA_SRC_* ref — identical to the body dumpDbToStdout
// emits (apps/hub-api/src/backups/backup-script.ts).
func redisSaveBody(cli, label string) string {
	return fmt.Sprintf(`r=$(%s --no-auth-warning SAVE 2>&1); if [ "$r" = OK ]; then cat /data/dump.rdb; else echo "%s SAVE failed: $r" >&2; exit 1; fi`, cli, label)
}

const dragonflyBody = `rm -f /data/tugra_backup.rdb; r=$(redis-cli --no-auth-warning SAVE RDB tugra_backup 2>&1); if [ "$r" = OK ]; then cat /data/tugra_backup.rdb; rc=0; else echo "dragonfly SAVE failed: $r" >&2; rc=1; fi; rm -f /data/tugra_backup.rdb; exit $rc`

// engineSpecs is the closed set of streamable engines, mirroring MIGRATOR_ENGINES in
// migrator-recipe.ts. An engine outside this map is NEVER run; a recipe whose command does not
// match the golden here is rejected for that engine (fail-closed tripwire).
var engineSpecs = map[string]engineSpec{
	"POSTGRES": {
		golden:   `docker exec -e PGPASSWORD "$TUGRA_SRC_CTR" pg_dump -Fc -Z0 --no-owner --no-acl -U "$TUGRA_SRC_USER" "$TUGRA_SRC_DB"`,
		format:   "pg_custom",
		pgFormat: "custom",
		bind:     Bind{Name: "PGPASSWORD", From: "pw"},
		usesUser: true,
		usesDB:   true,
		argv: func(c Creds) []string {
			return []string{"docker", "exec", "-e", "PGPASSWORD", c.Ctr, "pg_dump", "-Fc", "-Z0", "--no-owner", "--no-acl", "-U", c.User, c.DB}
		},
	},
	"MYSQL": {
		golden:   `docker exec -e MYSQL_PWD "$TUGRA_SRC_CTR" mysqldump --single-transaction --quick --no-tablespaces -u"$TUGRA_SRC_USER" --protocol=TCP -h127.0.0.1 "$TUGRA_SRC_DB"`,
		format:   "sql",
		bind:     Bind{Name: "MYSQL_PWD", From: "pw"},
		usesUser: true,
		usesDB:   true,
		argv: func(c Creds) []string {
			return []string{"docker", "exec", "-e", "MYSQL_PWD", c.Ctr, "mysqldump", "--single-transaction", "--quick", "--no-tablespaces", "-u" + c.User, "--protocol=TCP", "-h127.0.0.1", c.DB}
		},
	},
	"MARIADB": {
		golden:   `docker exec -e MYSQL_PWD "$TUGRA_SRC_CTR" mariadb-dump --single-transaction --quick -u"$TUGRA_SRC_USER" --protocol=TCP -h127.0.0.1 "$TUGRA_SRC_DB"`,
		format:   "sql",
		bind:     Bind{Name: "MYSQL_PWD", From: "pw"},
		usesUser: true,
		usesDB:   true,
		argv: func(c Creds) []string {
			return []string{"docker", "exec", "-e", "MYSQL_PWD", c.Ctr, "mariadb-dump", "--single-transaction", "--quick", "-u" + c.User, "--protocol=TCP", "-h127.0.0.1", c.DB}
		},
	},
	"REDIS": {
		golden: `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c '` + redisSaveBody("redis-cli", "REDIS") + `'`,
		format: "rdb",
		bind:   Bind{Name: "REDISCLI_AUTH", From: "pw"},
		argv: func(c Creds) []string {
			return []string{"docker", "exec", "-e", "REDISCLI_AUTH", c.Ctr, "sh", "-c", redisSaveBody("redis-cli", "REDIS")}
		},
	},
	"KEYDB": {
		golden: `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c '` + redisSaveBody("keydb-cli", "KEYDB") + `'`,
		format: "rdb",
		bind:   Bind{Name: "REDISCLI_AUTH", From: "pw"},
		argv: func(c Creds) []string {
			return []string{"docker", "exec", "-e", "REDISCLI_AUTH", c.Ctr, "sh", "-c", redisSaveBody("keydb-cli", "KEYDB")}
		},
	},
	"DRAGONFLY": {
		golden: `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c '` + dragonflyBody + `'`,
		format: "rdb",
		bind:   Bind{Name: "REDISCLI_AUTH", From: "pw"},
		argv: func(c Creds) []string {
			return []string{"docker", "exec", "-e", "REDISCLI_AUTH", c.Ctr, "sh", "-c", dragonflyBody}
		},
	},
}

// streamableEngines returns the sorted set of engine keys this binary can stream.
func streamableEngines() []string {
	out := make([]string, 0, len(engineSpecs))
	for k := range engineSpecs {
		out = append(out, k)
	}
	// insertion sort (tiny, deterministic, no imports)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Parsed is a recipe that passed the full static contract check for a known engine. It carries
// only the pinned spec, so BuildPlan never re-reads the (untrusted) hub command string.
type Parsed struct {
	Engine string
	spec   engineSpec
}

// ParseRecipe validates ONE engine's served recipe against the compiled-in contract and returns
// a Parsed on success. It is run for every served engine at fetch time, before any docker call.
// A failure means the recipe drifted or was tampered with: the caller skips that engine
// explicitly (never runs it). This is the consume-side mirror of migrator-recipe.ts's build-side
// asserts, collapsed to a byte-exact golden compare + an env-bind check (the strongest form: the
// hub chooses nothing).
func ParseRecipe(engine string, r Recipe) (*Parsed, error) {
	spec, ok := engineSpecs[engine]
	if !ok {
		return nil, fmt.Errorf("engine %q is not streamable", engine)
	}
	if r.Command != spec.golden {
		return nil, fmt.Errorf("recipe command for %s does not match the compiled contract (drift or tampering)", engine)
	}
	if r.Format != spec.format {
		return nil, fmt.Errorf("recipe format for %s is %q, expected %q", engine, r.Format, spec.format)
	}
	if r.PgFormat != spec.pgFormat {
		return nil, fmt.Errorf("recipe pgFormat for %s is %q, expected %q", engine, r.PgFormat, spec.pgFormat)
	}
	if len(r.Env) != 1 || r.Env[0] != spec.bind {
		return nil, fmt.Errorf("recipe env for %s does not match the single expected bind %s<-%s", engine, spec.bind.Name, spec.bind.From)
	}
	return &Parsed{Engine: engine, spec: spec}, nil
}

// ---- validation of locally-resolved values before they reach an argv ------------------------

// ctrRe is Docker's container-name charset, identical to nameRe in agent/internal/fsd/fsd.go:39.
// First char alnum excludes a leading '-' (option injection) and '/'. Also admits a 64-hex ID.
var ctrRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// userRe / dbRe bound the host-expanded $TUGRA_SRC_USER / $TUGRA_SRC_DB words. First char is not
// '-', and no shell metacharacter, quote, backslash, '$', whitespace, ';', '=' or '/' is allowed,
// so even though the recipe double-quotes them, a hostile value can never be read as an option or
// re-parsed as code. A legitimate-but-exotic name that fails is SKIPPED (fail-closed, never
// sanitised).
var userRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,79}$`)
var dbRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$`)

// cleanArgWord rejects any byte that could smuggle a newline/NUL/control/non-ASCII through the
// regexes (the regexes run against the whole value, but this is a cheap explicit pre-check and a
// clear error class). It never echoes the value.
func cleanArgWord(v string) bool {
	if v == "" || len(v) > 128 {
		return false
	}
	for i := 0; i < len(v); i++ {
		b := v[i]
		if b < 0x20 || b == 0x7f || b >= 0x80 {
			return false
		}
	}
	return true
}

func validContainer(v string) bool { return cleanArgWord(v) && ctrRe.MatchString(v) }
func validUser(v string) bool      { return cleanArgWord(v) && userRe.MatchString(v) }
func validDB(v string) bool        { return cleanArgWord(v) && dbRe.MatchString(v) }

// ---- the child env --------------------------------------------------------------------------

// childEnvAllowlist is the CLOSED set of env vars the dump child may inherit from the migrator.
// Everything else — above all the migration token, PGPASSWORD/MYSQL_PWD/REDISCLI_AUTH, PGUSER,
// LD_*/DYLD_*/BASH_ENV, SSH_AUTH_SOCK, *_PROXY, cloud creds — is dropped. The env is built by
// os.LookupEnv per name; os.Environ() is NEVER iterated.
var childEnvAllowlist = []string{
	"PATH",             // resolve the docker binary + in-recipe tools
	"HOME",             // docker CLI reads $HOME/.docker/config.json + contexts
	"DOCKER_HOST",      // operator's daemon endpoint (rootless unix socket / remote tcp)
	"DOCKER_CONTEXT",   // selects the operator's configured docker context
	"DOCKER_CONFIG",    // relocates config.json + the context store
	"DOCKER_CERT_PATH", // TLS client certs for a tcp:// DOCKER_HOST
	"DOCKER_TLS_VERIFY",
	"DOCKER_API_VERSION", // API pin for daemon skew
}

const defaultPath = "/usr/local/bin:/usr/bin:/bin"

// errInvalidCred is returned (with NO value in its message) when a resolved ctr/user/db fails
// validation, or a referenced user/db is unresolved. The item is reported failed:invalid-name.
type errInvalidCred struct{ field string }

func (e *errInvalidCred) Error() string { return "invalid or unresolved credential field: " + e.field }

// BuildPlan validates the resolved credentials for p's engine and returns a ready-to-exec Plan.
// lookup is os.LookupEnv (injectable for tests). dockerPath is the absolute docker binary.
//
// It enforces, per THE GO CONTRACT (migrator-recipe.ts:23-31):
//   - the child env is the allowlist + TUGRA_SRC_CTR (always) + TUGRA_SRC_USER/DB (only if the
//     command references them) + the one bound secret name, NEVER os.Environ();
//   - ctr/user/db are validated (charset, length, no leading '-', no control/NUL) before use;
//   - the OMIT-not-blank rule: an unresolved secret bind is left UNSET (so `docker exec -e NAME`
//     falls back to the container's own value) rather than exported empty, which would blank it.
//     But a referenced user/db that is unresolved is a HARD error (an empty positional would make
//     pg_dump/mysqldump silently dump the default DB) — fail closed.
func BuildPlan(p *Parsed, c Creds, dockerPath string, lookup func(string) (string, bool)) (Plan, error) {
	spec := p.spec
	if !validContainer(c.Ctr) {
		return Plan{}, &errInvalidCred{field: "container"}
	}
	if spec.usesUser && !validUser(c.User) {
		return Plan{}, &errInvalidCred{field: "user"}
	}
	if spec.usesDB && !validDB(c.DB) {
		return Plan{}, &errInvalidCred{field: "db"}
	}

	env := map[string]string{}
	for _, name := range childEnvAllowlist {
		if v, ok := lookup(name); ok && v != "" && !strings.ContainsRune(v, 0) {
			env[name] = v
		}
	}
	if _, ok := env["PATH"]; !ok {
		env["PATH"] = defaultPath // never leave PATH unset: docker/tool resolution must be deterministic
	}

	// TUGRA_SRC_* container-side words (never the password).
	env["TUGRA_SRC_CTR"] = c.Ctr
	if spec.usesUser {
		env["TUGRA_SRC_USER"] = c.User
	}
	if spec.usesDB {
		env["TUGRA_SRC_DB"] = c.DB
	}

	// The single bound secret, with the OMIT-not-blank rule.
	if spec.bind.From == "pw" {
		if c.HasPW && c.PW != "" && !strings.ContainsRune(c.PW, 0) {
			if _, dup := env[spec.bind.Name]; dup {
				return Plan{}, fmt.Errorf("bind name %s collides with an allowlisted var", spec.bind.Name)
			}
			env[spec.bind.Name] = c.PW
		}
		// else: OMITTED on purpose (not set to ""). A missing password surfaces as a loud dump
		// auth failure, never a blanked credential or a silent success.
	}

	return Plan{
		Argv:      spec.argv(c),
		Env:       flattenEnv(env),
		Engine:    p.Engine,
		Container: c.Ctr,
		Format:    spec.format,
		PgFormat:  spec.pgFormat,
	}, nil
}

// flattenEnv turns the map into a deterministic "k=v" slice (sorted for stable tests).
func flattenEnv(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
