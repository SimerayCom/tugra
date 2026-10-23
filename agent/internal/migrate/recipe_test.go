package migrate

import (
	"strings"
	"testing"
)

// goldenCommands pins the EXACT recipe command string each engine's recipe must carry. These are
// an independent copy of the strings asserted in apps/hub-api/src/importer/migrator-recipe.spec.ts.
// If the TS builder drifts, the served command stops matching engineSpecs[].golden AND this test's
// copy, so drift breaks CI on both sides.
var goldenCommands = map[string]string{
	"POSTGRES":  `docker exec -e PGPASSWORD "$TUGRA_SRC_CTR" pg_dump -Fc -Z0 --no-owner --no-acl -U "$TUGRA_SRC_USER" "$TUGRA_SRC_DB"`,
	"MYSQL":     `docker exec -e MYSQL_PWD "$TUGRA_SRC_CTR" mysqldump --single-transaction --quick --no-tablespaces -u"$TUGRA_SRC_USER" --protocol=TCP -h127.0.0.1 "$TUGRA_SRC_DB"`,
	"MARIADB":   `docker exec -e MYSQL_PWD "$TUGRA_SRC_CTR" mariadb-dump --single-transaction --quick -u"$TUGRA_SRC_USER" --protocol=TCP -h127.0.0.1 "$TUGRA_SRC_DB"`,
	"REDIS":     `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c 'r=$(redis-cli --no-auth-warning SAVE 2>&1); if [ "$r" = OK ]; then cat /data/dump.rdb; else echo "REDIS SAVE failed: $r" >&2; exit 1; fi'`,
	"KEYDB":     `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c 'r=$(keydb-cli --no-auth-warning SAVE 2>&1); if [ "$r" = OK ]; then cat /data/dump.rdb; else echo "KEYDB SAVE failed: $r" >&2; exit 1; fi'`,
	"DRAGONFLY": `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c 'rm -f /data/tugra_backup.rdb; r=$(redis-cli --no-auth-warning SAVE RDB tugra_backup 2>&1); if [ "$r" = OK ]; then cat /data/tugra_backup.rdb; rc=0; else echo "dragonfly SAVE failed: $r" >&2; rc=1; fi; rm -f /data/tugra_backup.rdb; exit $rc'`,
}

func TestGoldenMatchesSpec(t *testing.T) {
	if len(engineSpecs) != len(goldenCommands) {
		t.Fatalf("engine count drift: specs=%d golden=%d", len(engineSpecs), len(goldenCommands))
	}
	for engine, want := range goldenCommands {
		spec, ok := engineSpecs[engine]
		if !ok {
			t.Fatalf("no spec for %s", engine)
		}
		if spec.golden != want {
			t.Errorf("%s golden drift:\n got %q\nwant %q", engine, spec.golden, want)
		}
	}
}

func parseGolden(t *testing.T, engine string) *Parsed {
	t.Helper()
	spec := engineSpecs[engine]
	p, err := ParseRecipe(engine, Recipe{Command: spec.golden, Format: spec.format, PgFormat: spec.pgFormat, Env: []Bind{spec.bind}})
	if err != nil {
		t.Fatalf("ParseRecipe(%s) golden rejected: %v", engine, err)
	}
	return p
}

func TestParseRecipeAcceptsGolden(t *testing.T) {
	for engine := range goldenCommands {
		parseGolden(t, engine)
	}
}

func TestParseRecipeRejectsDrift(t *testing.T) {
	spec := engineSpecs["POSTGRES"]
	good := Recipe{Command: spec.golden, Format: spec.format, PgFormat: spec.pgFormat, Env: []Bind{spec.bind}}

	cases := []struct {
		name string
		mut  func(r Recipe) Recipe
	}{
		{"extra-flag", func(r Recipe) Recipe { r.Command += " -f /tmp/out"; return r }},
		{"injected", func(r Recipe) Recipe { r.Command = `docker exec "$TUGRA_SRC_CTR" sh -c 'id'`; return r }},
		{"wrong-format", func(r Recipe) Recipe { r.Format = "sql"; return r }},
		{"wrong-pgformat", func(r Recipe) Recipe { r.PgFormat = "plain"; return r }},
		{"extra-bind", func(r Recipe) Recipe { r.Env = append(r.Env, Bind{"DOCKER_HOST", "pw"}); return r }},
		{"bind-from-swap", func(r Recipe) Recipe { r.Env = []Bind{{"PGPASSWORD", "user"}}; return r }},
		{"renamed-bind", func(r Recipe) Recipe { r.Env = []Bind{{"PGUSER", "pw"}}; return r }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseRecipe("POSTGRES", tc.mut(good)); err == nil {
				t.Fatalf("expected %s to be rejected", tc.name)
			}
		})
	}
	if _, err := ParseRecipe("CLICKHOUSE", good); err == nil {
		t.Fatal("expected a non-streamable engine to be rejected")
	}
}

func lookupOf(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func envToMap(env []string) map[string]string {
	m := map[string]string{}
	for _, e := range env {
		if i := strings.IndexByte(e, '='); i >= 0 {
			m[e[:i]] = e[i+1:]
		}
	}
	return m
}

func TestBuildPlanPostgresEnvAndArgv(t *testing.T) {
	p := parseGolden(t, "POSTGRES")
	// Host env is POISONED with secrets that must NOT leak into the child.
	host := map[string]string{
		"PATH":                   "/usr/bin:/bin",
		"TUGRA_MIGRATION_TOKEN":  "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"PGPASSWORD":             "host-leftover",
		"PGUSER":                 "host-leftover",
		"LD_PRELOAD":             "/evil.so",
		"DOCKER_HOST":            "unix:///var/run/docker.sock",
	}
	creds := Creds{Ctr: "deadbeef", User: "appuser", DB: "appdb", PW: "s3cr3t'\"$x", HasPW: true}
	plan, err := BuildPlan(p, creds, "/usr/bin/docker", lookupOf(host))
	if err != nil {
		t.Fatal(err)
	}
	m := envToMap(plan.Env)
	// Allowlisted vars pass; everything else is dropped.
	if m["DOCKER_HOST"] != "unix:///var/run/docker.sock" {
		t.Error("DOCKER_HOST should pass the allowlist")
	}
	for _, forbidden := range []string{"TUGRA_MIGRATION_TOKEN", "LD_PRELOAD", "PGUSER"} {
		if _, ok := m[forbidden]; ok {
			t.Errorf("%s must never reach the child env", forbidden)
		}
	}
	// The host's leftover PGPASSWORD must be OVERRIDDEN by the resolved cred, never the host value.
	if m["PGPASSWORD"] != "s3cr3t'\"$x" {
		t.Errorf("PGPASSWORD should be the resolved cred, got %q", m["PGPASSWORD"])
	}
	if m["TUGRA_SRC_CTR"] != "deadbeef" || m["TUGRA_SRC_USER"] != "appuser" || m["TUGRA_SRC_DB"] != "appdb" {
		t.Errorf("TUGRA_SRC_* not set correctly: %v", m)
	}
	// The password must NEVER appear on the argv.
	for _, a := range plan.Argv {
		if strings.Contains(a, "s3cr3t") {
			t.Fatalf("password leaked onto argv: %q", a)
		}
	}
	want := []string{"docker", "exec", "-e", "PGPASSWORD", "deadbeef", "pg_dump", "-Fc", "-Z0", "--no-owner", "--no-acl", "-U", "appuser", "appdb"}
	if strings.Join(plan.Argv, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("argv:\n got %v\nwant %v", plan.Argv, want)
	}
}

func TestBuildPlanOmitsUnresolvedPassword(t *testing.T) {
	p := parseGolden(t, "POSTGRES")
	host := map[string]string{"PATH": "/usr/bin:/bin", "PGPASSWORD": "host-leftover"}
	creds := Creds{Ctr: "deadbeef", User: "u", DB: "d", HasPW: false} // no password
	plan, err := BuildPlan(p, creds, "/usr/bin/docker", lookupOf(host))
	if err != nil {
		t.Fatal(err)
	}
	m := envToMap(plan.Env)
	// OMIT-not-blank: PGPASSWORD must be absent (NOT "" and NOT the host leftover), so `docker exec
	// -e PGPASSWORD` falls back to the container's own value.
	if _, ok := m["PGPASSWORD"]; ok {
		t.Fatalf("an unresolved password must be OMITTED from the child env, got %q", m["PGPASSWORD"])
	}
	for _, e := range plan.Env {
		if e == "PGPASSWORD=" {
			t.Fatal("must never export a blank PGPASSWORD")
		}
	}
}

func TestBuildPlanRejectsHostileNames(t *testing.T) {
	p := parseGolden(t, "POSTGRES")
	host := map[string]string{"PATH": "/usr/bin:/bin"}
	bad := []Creds{
		{Ctr: "-rm", User: "u", DB: "d", PW: "p", HasPW: true},
		{Ctr: "ok", User: "--all-databases", DB: "d", PW: "p", HasPW: true},
		{Ctr: "ok", User: "u", DB: "-hevil", PW: "p", HasPW: true},
		{Ctr: "ok", User: "u", DB: "a\nb", PW: "p", HasPW: true},
		{Ctr: "ok", User: "u", DB: "a\x00b", PW: "p", HasPW: true},
		{Ctr: "ok", User: "u", DB: "", PW: "p", HasPW: true},
	}
	for i, c := range bad {
		if _, err := BuildPlan(p, c, "/usr/bin/docker", lookupOf(host)); err == nil {
			t.Errorf("case %d: expected a hostile value to be rejected (%+v)", i, c)
		}
	}
}

func TestBuildPlanRedisHasNoUserDB(t *testing.T) {
	p := parseGolden(t, "REDIS")
	host := map[string]string{"PATH": "/usr/bin:/bin"}
	plan, err := BuildPlan(p, Creds{Ctr: "deadbeef", PW: "pw", HasPW: true}, "/usr/bin/docker", lookupOf(host))
	if err != nil {
		t.Fatal(err)
	}
	m := envToMap(plan.Env)
	if _, ok := m["TUGRA_SRC_USER"]; ok {
		t.Error("redis must not export TUGRA_SRC_USER")
	}
	if _, ok := m["TUGRA_SRC_DB"]; ok {
		t.Error("redis must not export TUGRA_SRC_DB")
	}
	if m["REDISCLI_AUTH"] != "pw" {
		t.Error("redis bind REDISCLI_AUTH missing")
	}
	if plan.Argv[len(plan.Argv)-2] != "-c" {
		t.Errorf("redis argv should end with sh -c <body>, got %v", plan.Argv)
	}
}
