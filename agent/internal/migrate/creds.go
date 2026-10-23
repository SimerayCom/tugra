package migrate

import "strings"

// inspectInfo is the minimal slice of `docker inspect` output the credential resolver needs. Env
// is Config.Env ("K=V" entries) and carries the DB password; it is held only transiently and is
// NEVER logged, formatted or put in an error (the resolver returns only values + a fixed reason).
type inspectInfo struct {
	Env        []string // Config.Env
	Path       string   // .Path (the executed entrypoint)
	Args       []string // .Args (the executed args)
	Entrypoint []string // Config.Entrypoint (fallback)
	Cmd        []string // Config.Cmd (fallback)
}

// resolved is what the resolver hands back for an engine it could discover creds for. Fields the
// engine's recipe does not consume are left empty (least privilege).
type resolved struct {
	user string
	db   string
	pw   string
}

// skip is a fail-closed skip with a FIXED, value-free reason code (never a credential or raw
// error). Mirrors the closed enum designed for creds.go.
type skip struct{ reason string }

const (
	skipCredsNotFound  = "credentials-not-discoverable"
	skipPWNotFound     = "password-not-discoverable"
	skipSecretFile     = "secret-file-unsupported"
	skipACLUser        = "acl-user-unsupported"
	skipDBNotFound     = "db-not-discoverable"
	skipEngineUnsup    = "engine-unsupported"
	skipRandomRootOnly = "credentials-not-discoverable"
)

// resolveCreds discovers (user, db, pw) for one of the six streamable engines from a container's
// inspected env + executed argv. A non-nil *skip means the item is fail-closed skipped with that
// reason: nothing is dumped, no `docker exec` is spawned. This is deliberately STRICTER than the
// TS contract's omit-unresolved-binding fallback — for all six engines auth is mandatory, so an
// unauthenticated/undiscoverable source is reported skipped (with a reason) rather than dumped as
// if OK.
func resolveCreds(engine string, in inspectInfo) (resolved, *skip) {
	env := parseEnvKV(in.Env)
	switch engine {
	case "POSTGRES":
		return resolvePostgres(env)
	case "MYSQL":
		return resolveMySQLFamily(env, []string{"MYSQL"}, false)
	case "MARIADB":
		return resolveMySQLFamily(env, []string{"MARIADB", "MYSQL"}, true)
	case "REDIS":
		return resolveRedisFamily(env, in, []string{"REDIS_PASSWORD"})
	case "KEYDB":
		return resolveRedisFamily(env, in, []string{"KEYDB_PASSWORD"})
	case "DRAGONFLY":
		return resolveRedisFamily(env, in, []string{"DFLY_requirepass", "DRAGONFLY_PASSWORD"})
	default:
		// CLICKHOUSE / MONGO / LIBSQL are reported `unsupported` by the hub and never reach here.
		return resolved{}, &skip{skipEngineUnsup}
	}
}

func resolvePostgres(env map[string]string) (resolved, *skip) {
	if _, ok := env["POSTGRES_PASSWORD_FILE"]; ok {
		if env["POSTGRES_PASSWORD"] == "" {
			return resolved{}, &skip{skipSecretFile} // never read the file
		}
	}
	pw := env["POSTGRES_PASSWORD"]
	if pw == "" {
		return resolved{}, &skip{skipPWNotFound} // no HOST_AUTH_METHOD=trust support in v1 (fail-closed)
	}
	user := env["POSTGRES_USER"]
	if user == "" {
		user = "postgres" // documented image default
	}
	db := env["POSTGRES_DB"]
	if db == "" {
		db = user // documented image default: db == user
	}
	return resolved{user: user, db: db, pw: pw}, nil
}

// resolveMySQLFamily implements the root-first, tier-atomic rule for MySQL and MariaDB. prefixes
// is the per-variable alias precedence (["MARIADB","MYSQL"] for MariaDB, ["MYSQL"] for MySQL). A
// user from one tier is NEVER paired with a password from the other.
func resolveMySQLFamily(env map[string]string, prefixes []string, _ bool) (resolved, *skip) {
	// A *_FILE secret with no inline value cannot be honored.
	for _, p := range prefixes {
		for _, suf := range []string{"ROOT_PASSWORD_FILE", "PASSWORD_FILE"} {
			if _, ok := env[p+"_"+suf]; ok {
				base := strings.TrimSuffix(p+"_"+suf, "_FILE")
				if env[base] == "" {
					return resolved{}, &skip{skipSecretFile}
				}
			}
		}
	}

	db := firstNonEmpty(env, suffixed(prefixes, "DATABASE"))
	if db == "" {
		return resolved{}, &skip{skipDBNotFound} // the recipe dumps exactly one DB; no default, no --all-databases
	}

	randomRoot := firstNonEmpty(env, suffixed(prefixes, "RANDOM_ROOT_PASSWORD")) != ""

	// Tier 1: ROOT. Blocked when the entrypoint randomised the root password (the inspected value
	// is then a lie), or when only a *_ROOT_PASSWORD_HASH is present (unusable).
	if !randomRoot {
		if rootPW := firstNonEmpty(env, suffixed(prefixes, "ROOT_PASSWORD")); rootPW != "" {
			return resolved{user: "root", db: db, pw: rootPW}, nil
		}
	}

	// Tier 2: APP user.
	appUser := firstNonEmpty(env, suffixed(prefixes, "USER"))
	appPW := firstNonEmpty(env, suffixed(prefixes, "PASSWORD"))
	if appUser != "" && appPW != "" && appUser != "root" {
		return resolved{user: appUser, db: db, pw: appPW}, nil
	}
	return resolved{}, &skip{skipCredsNotFound}
}

// resolveRedisFamily resolves the password for REDIS / KEYDB / DRAGONFLY, fail-closed. Source
// order: the executed argv `--requirepass <v>` (last occurrence wins; it is what the server really
// got), then the engine's env alias(es). Empty / absent / unresolvable => skip (never dump an
// unauthenticated instance as if OK). An ACL user other than default is unsupported.
func resolveRedisFamily(env map[string]string, in inspectInfo, envAliases []string) (resolved, *skip) {
	if u := env["REDIS_USERNAME"]; u != "" && u != "default" {
		return resolved{}, &skip{skipACLUser} // REDISCLI_AUTH authenticates the default user only
	}
	// argv --requirepass is authoritative: if it is PRESENT we never fall through to an env alias,
	// so a `--requirepass $MISSING` the server would reject is reported skipped, not masked by a
	// stale env value.
	if pw, found := requirepassFromArgv(in, env); found {
		if pw != "" {
			return resolved{pw: pw}, nil
		}
		return resolved{}, &skip{skipPWNotFound}
	}
	for _, a := range envAliases {
		if v := env[a]; v != "" {
			return resolved{pw: v}, nil
		}
	}
	return resolved{}, &skip{skipPWNotFound}
}

// ---- helpers --------------------------------------------------------------------------------

// parseEnvKV turns Config.Env entries into a map. Split at the FIRST '='; a later duplicate wins
// (docker's own semantics); an entry with no '=' is ignored. Names are case-sensitive
// (DFLY_requirepass is mixed case).
func parseEnvKV(entries []string) map[string]string {
	m := make(map[string]string, len(entries))
	for _, e := range entries {
		if i := strings.IndexByte(e, '='); i >= 0 {
			m[e[:i]] = e[i+1:]
		}
	}
	return m
}

func suffixed(prefixes []string, suffix string) []string {
	out := make([]string, len(prefixes))
	for i, p := range prefixes {
		out[i] = p + "_" + suffix
	}
	return out
}

func firstNonEmpty(env map[string]string, keys []string) string {
	for _, k := range keys {
		if v := env[k]; v != "" {
			return v
		}
	}
	return ""
}

// requirepassFromArgv scans the container's executed command for `--requirepass <v>` or
// `--requirepass=<v>` (the LAST occurrence wins) and resolves the value: a literal is used after
// one layer of quote removal; a value that is EXACTLY $NAME or ${NAME} is resolved against the
// container's own env (must be non-empty); any other `$` form is unresolvable. Tokens containing
// whitespace are quote-aware re-split without expansion.
func requirepassFromArgv(in inspectInfo, env map[string]string) (string, bool) {
	var raw []string
	if in.Path != "" || len(in.Args) > 0 {
		raw = append([]string{in.Path}, in.Args...)
	} else {
		raw = append(append([]string{}, in.Entrypoint...), in.Cmd...)
	}
	// Flatten: a single token may itself be a quoted shell fragment (`sh -c 'redis-server --requirepass "$X"'`).
	var toks []string
	for _, t := range raw {
		if strings.ContainsAny(t, " \t") {
			if split, ok := shlexNoExpand(t); ok {
				toks = append(toks, split...)
				continue
			}
			// unbalanced quotes => treat the whole token as opaque (cannot safely parse)
		}
		toks = append(toks, t)
	}

	val, found := "", false
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		var cand string
		var has bool
		if t == "--requirepass" {
			if i+1 < len(toks) {
				next := toks[i+1]
				if !strings.HasPrefix(next, "--") {
					cand, has = next, true
				}
			}
		} else if after, ok := strings.CutPrefix(t, "--requirepass="); ok {
			cand, has = after, true
		}
		if has {
			if resolvedVal, ok := resolveArgValue(cand, env); ok {
				val, found = resolvedVal, true // last occurrence wins
			} else {
				val, found = "", true // present but unresolvable: do not fall through to env alias
			}
		}
	}
	return val, found
}

// resolveArgValue resolves one argv value: exact $NAME / ${NAME} against env (non-empty required),
// a literal otherwise. Any other `$` expansion form (pre$X, ${X:-d}, command substitution) is
// unresolvable.
func resolveArgValue(v string, env map[string]string) (string, bool) {
	if v == "" {
		return "", false
	}
	if !strings.Contains(v, "$") {
		return v, true
	}
	name := ""
	if strings.HasPrefix(v, "${") && strings.HasSuffix(v, "}") {
		name = v[2 : len(v)-1]
	} else if strings.HasPrefix(v, "$") {
		name = v[1:]
	}
	if name != "" && isPlainEnvName(name) {
		if ev := env[name]; ev != "" {
			return ev, true
		}
	}
	return "", false
}

func isPlainEnvName(n string) bool {
	for i := 0; i < len(n); i++ {
		b := n[i]
		if !(b == '_' || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')) {
			return false
		}
	}
	return n != ""
}

// shlexNoExpand splits a shell-fragment token into words, honoring single and double quotes but
// performing NO variable/command expansion (a `$NAME` stays the literal text `$NAME`). Returns
// false on an unbalanced quote.
func shlexNoExpand(s string) ([]string, bool) {
	var out []string
	var cur strings.Builder
	inWord := false
	state := 0 // 0 none, 1 single, 2 double
	flush := func() {
		if inWord {
			out = append(out, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch state {
		case 0:
			switch c {
			case ' ', '\t':
				flush()
			case '\'':
				state, inWord = 1, true
			case '"':
				state, inWord = 2, true
			case '\\':
				if i+1 < len(s) {
					i++
					cur.WriteByte(s[i])
					inWord = true
				}
			default:
				cur.WriteByte(c)
				inWord = true
			}
		case 1:
			if c == '\'' {
				state = 0
			} else {
				cur.WriteByte(c)
			}
		case 2:
			if c == '"' {
				state = 0
			} else if c == '\\' && i+1 < len(s) && (s[i+1] == '"' || s[i+1] == '\\' || s[i+1] == '$' || s[i+1] == '`') {
				i++
				cur.WriteByte(s[i])
			} else {
				cur.WriteByte(c)
			}
		}
	}
	if state != 0 {
		return nil, false // unbalanced quote
	}
	flush()
	return out, true
}
