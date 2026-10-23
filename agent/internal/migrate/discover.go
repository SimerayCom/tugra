package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Discovery outcomes. run.go maps each to either an item skip (ErrNotFound/ErrNotRunning:
// the DB may live on another Coolify server, or is stopped) or a run-affecting failure
// (ErrAmbiguous/ErrForbidden/ErrEngineMismatch indicate a WRONG mapping, not a missing one).
var (
	ErrNotFound       = errors.New("no matching source container on this host")
	ErrAmbiguous      = errors.New("the source reference matched more than one container")
	ErrForbidden      = errors.New("refusing a Tugra/Coolify control-plane container")
	ErrNotRunning     = errors.New("the source container is not running")
	ErrEngineMismatch = errors.New("the source container engine does not match the provisioned target")
)

// Target is one entry from GET /targets.
type Target struct {
	ItemRef   string `json:"itemRef"`
	Kind      string `json:"kind"`
	Engine    string `json:"engine"`
	DataPlane string `json:"dataPlane"`
	Reason    string `json:"reason"`
}

// source is a validated, running source DB container. ID is the immutable 64-hex container ID
// (used as TUGRA_SRC_CTR and as the exec target so a rename/recreate cannot redirect the dump).
type source struct {
	ID      string
	Name    string
	Image   string
	Digest  string
	Engine  string
	inspect inspectInfo
}

// runDocker runs a docker CLI argv and returns stdout + trimmed stderr. Package var so tests stub
// the daemon exactly like fsd.runHelper (agent/internal/fsd/run.go). env is the allowlisted child
// env (never os.Environ). It is always an argv slice — never a shell string.
var runDocker = func(ctx context.Context, argv []string, env []string) (stdout []byte, stderr string, err error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err = cmd.Run()
	return []byte(out.String()), strings.TrimSpace(errb.String()), err
}

var hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
var hex12Re = regexp.MustCompile(`^[0-9a-f]{12}$`)
var sourceRefRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`) // a strict subset of fsd nameRe (no '.')

// ParseItemRef splits `database:<serverRef|_>:<sourceRef>` (import-planner.ts ns()). serverRef is
// carried only for messages; it is never used to select a container (the source host does not
// know its Coolify server uuid). sourceRef must be docker-name-safe and contain no '.', ':' etc.
func ParseItemRef(itemRef string) (serverRef, sourceRef string, err error) {
	if len(itemRef) == 0 || len(itemRef) > 256 {
		return "", "", fmt.Errorf("bad itemRef length")
	}
	parts := strings.SplitN(itemRef, ":", 3)
	if len(parts) != 3 || parts[0] != "database" {
		return "", "", fmt.Errorf("itemRef is not a database ref")
	}
	serverRef, sourceRef = parts[1], parts[2]
	if !sourceRefRe.MatchString(sourceRef) {
		return "", "", fmt.Errorf("source reference has an unsafe charset")
	}
	return serverRef, sourceRef, nil
}

// psRow is one `docker ps -a` line.
type psRow struct {
	id    string
	names []string
}

// dockerInspectJSON is the minimal slice of `docker inspect` we decode.
type dockerInspectJSON struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	Image string `json:"Image"` // sha256:... (the image digest)
	Path  string `json:"Path"`
	Args  []string `json:"Args"`
	State struct {
		Running    bool `json:"Running"`
		Paused     bool `json:"Paused"`
		Restarting bool `json:"Restarting"`
		Dead       bool `json:"Dead"`
	} `json:"State"`
	Config struct {
		Image      string            `json:"Image"`
		Env        []string          `json:"Env"`
		Labels     map[string]string `json:"Labels"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
	} `json:"Config"`
}

// dockerCallTimeout bounds a single docker ps/inspect so a wedged daemon cannot stall the run.
const dockerCallTimeout = 30 * time.Second

// Resolve maps one Target to a validated running source container. override is the --map value for
// this itemRef ("" if none). dockerPath is the vetted absolute docker binary (argv[0]); env is the
// allowlisted docker child env.
func Resolve(ctx context.Context, tg Target, override, dockerPath string, env []string) (*source, error) {
	if tg.Kind != "database" {
		return nil, ErrNotFound
	}
	if _, ok := engineSpecs[tg.Engine]; !ok {
		return nil, ErrEngineMismatch // engine the migrator does not stream (hub marks unsupported)
	}
	_, sourceRef, err := ParseItemRef(tg.ItemRef)
	if err != nil {
		return nil, err
	}

	rows, err := dockerPS(ctx, dockerPath, env)
	if err != nil {
		return nil, err
	}

	var id string
	if override != "" {
		if id, err = resolveOverride(override, rows); err != nil {
			return nil, err
		}
	} else {
		id, err = resolveByName(sourceRef, rows)
		if err != nil {
			return nil, err
		}
	}

	info, err := dockerInspect(ctx, dockerPath, id, env)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(info.ID, id) {
		return nil, ErrNotFound // the daemon returned a different container than we asked for
	}
	name := strings.TrimPrefix(info.Name, "/")
	if override == "" && name != sourceRef {
		return nil, ErrNotFound // auto path: the inspected name must equal the uuid we matched
	}
	if isForbiddenName(name) || isForbiddenName(sourceRef) {
		return nil, ErrForbidden
	}
	if !(info.State.Running && !info.State.Paused && !info.State.Restarting && !info.State.Dead) {
		return nil, ErrNotRunning
	}
	envMap := parseEnvKV(info.Config.Env)
	cls := classifyEngine(info.Config.Image, envMap)
	if cls == "" || cls != tg.Engine {
		return nil, ErrEngineMismatch
	}
	return &source{
		ID:     info.ID,
		Name:   name,
		Image:  info.Config.Image,
		Digest: info.Image,
		Engine: tg.Engine,
		inspect: inspectInfo{
			Env:        info.Config.Env,
			Path:       info.Path,
			Args:       info.Args,
			Entrypoint: info.Config.Entrypoint,
			Cmd:        info.Config.Cmd,
		},
	}, nil
}

func dockerPS(ctx context.Context, dockerPath string, env []string) ([]psRow, error) {
	cctx, cancel := context.WithTimeout(ctx, dockerCallTimeout)
	defer cancel()
	out, stderr, err := runDocker(cctx, []string{dockerPath, "ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"}, env)
	if err != nil {
		return nil, fmt.Errorf("docker ps failed: %v (%s)", err, firstLine(stderr))
	}
	var rows []psRow
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		tab := strings.IndexByte(line, '\t')
		if tab < 0 {
			continue
		}
		id := strings.TrimSpace(line[:tab])
		if !hex64Re.MatchString(id) {
			continue
		}
		var names []string
		for _, n := range strings.Split(line[tab+1:], ",") {
			if n = strings.TrimSpace(n); n != "" {
				names = append(names, n)
			}
		}
		rows = append(rows, psRow{id: id, names: names})
	}
	return rows, nil
}

// resolveByName is a byte-exact name match (never a prefix/regex/inspect-by-name, which would also
// resolve ID prefixes). 0 hits => ErrNotFound; >1 => ErrAmbiguous (a fail-closed guard).
func resolveByName(sourceRef string, rows []psRow) (string, error) {
	var hits []string
	for _, r := range rows {
		for _, n := range r.names {
			if n == sourceRef {
				hits = append(hits, r.id)
				break
			}
		}
	}
	switch len(hits) {
	case 0:
		return "", ErrNotFound
	case 1:
		return hits[0], nil
	default:
		return "", ErrAmbiguous
	}
}

// resolveOverride resolves a --map value: an exact container name, a full 64-hex ID, or a 12-hex
// short ID matching exactly one container. A value matching BOTH a name and an ID prefix is
// ambiguous (fail-closed).
func resolveOverride(val string, rows []psRow) (string, error) {
	var byName, byID []string
	for _, r := range rows {
		for _, n := range r.names {
			if n == val {
				byName = append(byName, r.id)
				break
			}
		}
		if hex64Re.MatchString(val) && r.id == val {
			byID = append(byID, r.id)
		} else if hex12Re.MatchString(val) && strings.HasPrefix(r.id, val) {
			byID = append(byID, r.id)
		}
	}
	all := dedup(append(append([]string{}, byName...), byID...))
	switch len(all) {
	case 0:
		return "", ErrNotFound
	case 1:
		return all[0], nil
	default:
		return "", ErrAmbiguous
	}
}

func dockerInspect(ctx context.Context, dockerPath, id string, env []string) (*dockerInspectJSON, error) {
	if !hex64Re.MatchString(id) {
		return nil, fmt.Errorf("refusing to inspect a non-ID value")
	}
	cctx, cancel := context.WithTimeout(ctx, dockerCallTimeout)
	defer cancel()
	out, stderr, err := runDocker(cctx, []string{dockerPath, "inspect", "--type", "container", "--format", "{{json .}}", "--", id}, env)
	if err != nil {
		return nil, fmt.Errorf("docker inspect failed: %v (%s)", err, firstLine(stderr))
	}
	if len(out) > 4<<20 {
		return nil, fmt.Errorf("docker inspect output too large")
	}
	var info dockerInspectJSON
	if err := json.Unmarshal(trimJSON(out), &info); err != nil {
		return nil, fmt.Errorf("docker inspect output could not be parsed")
	}
	return &info, nil
}

// forbidden control-plane names (exact), plus the tugra_/tugra- prefix handled separately.
var forbiddenExact = map[string]bool{
	"coolify": true, "coolify-db": true, "coolify-redis": true, "coolify-realtime": true,
	"coolify-proxy": true, "coolify-sentinel": true, "coolify-helper": true,
}

// isForbiddenName refuses Tugra's own containers (tugra_db_*, tugra_dbv_*, tugra-fsd-*, the
// agent/migrator) so the destination is never dumped into itself, and Coolify's control plane
// (coolify-db is a real Postgres holding instance secrets and would otherwise pass the engine
// proof).
func isForbiddenName(name string) bool {
	l := strings.ToLower(name)
	if strings.HasPrefix(l, "tugra_") || strings.HasPrefix(l, "tugra-") {
		return true
	}
	return forbiddenExact[l]
}

// classifyEngine maps an image to one of the six streamable engine keys, with an env-signature
// fallback for an unrecognised image. The image-name precedence mirrors coolify-map.ts: keydb and
// dragonfly BEFORE redis, mariadb BEFORE mysql/postgres. An unknown engine returns "" (the item is
// then refused, never run with an unproven engine).
func classifyEngine(image string, env map[string]string) string {
	base := imageBasename(image)
	switch {
	case strings.Contains(base, "keydb"):
		return "KEYDB"
	case strings.Contains(base, "dragonfly"):
		return "DRAGONFLY"
	case strings.Contains(base, "mariadb"):
		return "MARIADB"
	case strings.Contains(base, "postgres") || strings.Contains(base, "postgis"):
		return "POSTGRES"
	case strings.Contains(base, "mysql"):
		return "MYSQL"
	case strings.Contains(base, "redis"):
		return "REDIS"
	}
	// env-signature fallback (image unrecognised, e.g. a private registry tag)
	switch {
	case has(env, "POSTGRES_PASSWORD") || has(env, "POSTGRES_USER"):
		return "POSTGRES"
	case has(env, "MARIADB_ROOT_PASSWORD") || has(env, "MARIADB_PASSWORD") || has(env, "MARIADB_DATABASE"):
		return "MARIADB"
	case has(env, "MYSQL_ROOT_PASSWORD") || has(env, "MYSQL_DATABASE"):
		return "MYSQL"
	case has(env, "KEYDB_PASSWORD"):
		return "KEYDB"
	case has(env, "REDIS_PASSWORD"):
		return "REDIS"
	}
	return ""
}

// imageBasename strips the registry host:port, tag and @digest, leaving the repo path's last
// segment lowercased.
func imageBasename(image string) string {
	s := image
	if at := strings.IndexByte(s, '@'); at >= 0 {
		s = s[:at]
	}
	// strip tag: the last ':' AFTER the last '/' (a registry port colon has no following '/')
	if slash := strings.LastIndexByte(s, '/'); slash >= 0 {
		if colon := strings.LastIndexByte(s[slash:], ':'); colon >= 0 {
			s = s[:slash+colon]
		}
	} else if colon := strings.LastIndexByte(s, ':'); colon >= 0 {
		s = s[:colon]
	}
	if slash := strings.LastIndexByte(s, '/'); slash >= 0 {
		s = s[slash+1:]
	}
	return strings.ToLower(s)
}

func has(env map[string]string, k string) bool { _, ok := env[k]; return ok }

func dedup(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// trimJSON strips a trailing newline the `{{json .}}` format appends.
func trimJSON(b []byte) []byte { return []byte(strings.TrimSpace(string(b))) }
