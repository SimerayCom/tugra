package migrate

import "testing"

func env(pairs ...string) inspectInfo { return inspectInfo{Env: pairs} }

func TestResolvePostgres(t *testing.T) {
	r, sk := resolveCreds("POSTGRES", env("POSTGRES_PASSWORD=pw"))
	if sk != nil {
		t.Fatalf("unexpected skip: %s", sk.reason)
	}
	if r.user != "postgres" || r.db != "postgres" || r.pw != "pw" {
		t.Errorf("defaults wrong: %+v", r)
	}
	r, _ = resolveCreds("POSTGRES", env("POSTGRES_USER=alice", "POSTGRES_PASSWORD=pw"))
	if r.db != "alice" {
		t.Errorf("db should default to user, got %q", r.db)
	}
	if _, sk := resolveCreds("POSTGRES", env("POSTGRES_USER=x")); sk == nil || sk.reason != skipPWNotFound {
		t.Error("empty password must fail closed")
	}
	if _, sk := resolveCreds("POSTGRES", env("POSTGRES_PASSWORD_FILE=/run/secret")); sk == nil || sk.reason != skipSecretFile {
		t.Error("password-file must skip without reading it")
	}
}

func TestResolveMySQLRootFirst(t *testing.T) {
	// both root and app present => root wins, never cross-paired
	r, sk := resolveCreds("MYSQL", env("MYSQL_ROOT_PASSWORD=rootpw", "MYSQL_USER=app", "MYSQL_PASSWORD=apppw", "MYSQL_DATABASE=d"))
	if sk != nil {
		t.Fatalf("skip: %s", sk.reason)
	}
	if r.user != "root" || r.pw != "rootpw" {
		t.Errorf("root-first failed: %+v", r)
	}
	// random root => fall through to app tier
	r, sk = resolveCreds("MYSQL", env("MYSQL_ROOT_PASSWORD=junk", "MYSQL_RANDOM_ROOT_PASSWORD=yes", "MYSQL_USER=app", "MYSQL_PASSWORD=apppw", "MYSQL_DATABASE=d"))
	if sk != nil || r.user != "app" || r.pw != "apppw" {
		t.Errorf("random-root should fall through to app: %+v sk=%v", r, sk)
	}
	// db missing => skip even with root creds
	if _, sk := resolveCreds("MYSQL", env("MYSQL_ROOT_PASSWORD=rootpw")); sk == nil || sk.reason != skipDBNotFound {
		t.Error("missing database must skip")
	}
}

func TestResolveMariaDBAliasPrecedence(t *testing.T) {
	// MARIADB_* beats MYSQL_* per variable
	r, sk := resolveCreds("MARIADB", env("MARIADB_ROOT_PASSWORD=mdbpw", "MYSQL_ROOT_PASSWORD=mysqlpw", "MARIADB_DATABASE=d"))
	if sk != nil || r.pw != "mdbpw" {
		t.Errorf("MARIADB_ should beat MYSQL_: %+v sk=%v", r, sk)
	}
	// mixed spellings (castopod-style: MYSQL_ROOT_PASSWORD on a mariadb image) still resolve
	r, sk = resolveCreds("MARIADB", env("MYSQL_ROOT_PASSWORD=mysqlpw", "MARIADB_DATABASE=d"))
	if sk != nil || r.pw != "mysqlpw" {
		t.Errorf("MYSQL_ fallback on mariadb failed: %+v sk=%v", r, sk)
	}
}

func TestResolveRedisFamily(t *testing.T) {
	// empty / absent => fail closed
	if _, sk := resolveCreds("REDIS", env()); sk == nil || sk.reason != skipPWNotFound {
		t.Error("no password must fail closed")
	}
	// env alias
	if r, sk := resolveCreds("REDIS", env("REDIS_PASSWORD=pw")); sk != nil || r.pw != "pw" {
		t.Errorf("REDIS_PASSWORD not used: %+v sk=%v", r, sk)
	}
	// ACL user => skip
	if _, sk := resolveCreds("REDIS", env("REDIS_PASSWORD=pw", "REDIS_USERNAME=bob")); sk == nil || sk.reason != skipACLUser {
		t.Error("non-default ACL user must skip")
	}
	// argv --requirepass, last wins, beats env
	in := inspectInfo{Env: []string{"REDIS_PASSWORD=envpw"}, Path: "redis-server", Args: []string{"--requirepass", "first", "--requirepass", "second"}}
	if r, sk := resolveCreds("REDIS", in); sk != nil || r.pw != "second" {
		t.Errorf("last --requirepass should win: %+v sk=%v", r, sk)
	}
	// --requirepass= form
	in = inspectInfo{Path: "redis-server", Args: []string{"--requirepass=eqpw"}}
	if r, sk := resolveCreds("REDIS", in); sk != nil || r.pw != "eqpw" {
		t.Errorf("--requirepass= form failed: %+v sk=%v", r, sk)
	}
	// sh -c one-token form from a Coolify template
	in = inspectInfo{Path: "sh", Args: []string{"-c", `redis-server --requirepass "topsecret"`}}
	if r, sk := resolveCreds("REDIS", in); sk != nil || r.pw != "topsecret" {
		t.Errorf("sh -c one-token form failed: %+v sk=%v", r, sk)
	}
	// $VAR that resolves against the container env
	in = inspectInfo{Env: []string{"PW=frompw"}, Path: "redis-server", Args: []string{"--requirepass", "$PW"}}
	if r, sk := resolveCreds("REDIS", in); sk != nil || r.pw != "frompw" {
		t.Errorf("$VAR resolution failed: %+v sk=%v", r, sk)
	}
	// unresolvable $VAR present => NOT falling through to env alias (fail closed)
	in = inspectInfo{Env: []string{"REDIS_PASSWORD=envpw"}, Path: "redis-server", Args: []string{"--requirepass", "$MISSING"}}
	if _, sk := resolveCreds("REDIS", in); sk == nil {
		t.Error("an unresolvable --requirepass must not fall through to the env alias")
	}
}

func TestResolveKeyDBDragonfly(t *testing.T) {
	if r, sk := resolveCreds("KEYDB", env("KEYDB_PASSWORD=kp")); sk != nil || r.pw != "kp" {
		t.Errorf("keydb env alias: %+v sk=%v", r, sk)
	}
	in := inspectInfo{Path: "dragonfly", Args: []string{"--requirepass=dfp"}}
	if r, sk := resolveCreds("DRAGONFLY", in); sk != nil || r.pw != "dfp" {
		t.Errorf("dragonfly --requirepass=: %+v sk=%v", r, sk)
	}
	if r, sk := resolveCreds("DRAGONFLY", env("DFLY_requirepass=dfenv")); sk != nil || r.pw != "dfenv" {
		t.Errorf("dragonfly DFLY_requirepass: %+v sk=%v", r, sk)
	}
}

func TestShlexNoExpand(t *testing.T) {
	got, ok := shlexNoExpand(`redis-server --requirepass "a b" $KEEP`)
	if !ok {
		t.Fatal("balanced quotes should parse")
	}
	want := []string{"redis-server", "--requirepass", "a b", "$KEEP"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("tok %d: got %q want %q", i, got[i], want[i])
		}
	}
	if _, ok := shlexNoExpand(`redis-server --requirepass "unterminated`); ok {
		t.Error("unbalanced quote should fail")
	}
}
