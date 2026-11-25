package scan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// This file is the data source for the hub's "Move to Tugra" planner for PM2 processes. It reads the same files as the
// scan (dump.pm2, pids/) and adds what a faithful re-creation needs: the interpreter, the argument vectors, the owner
// of the PM2 home and of the working directory, the Node version hints (.nvmrc, package.json engines.node) and,
// ONLY for one explicitly named process (--env), its environment. The listing form never carries an environment value:
// just a key count and a digest, so the hub can tell the process changed between the preview and the move.
//
// It never runs pm2, never writes and never talks to a daemon.

// PM2ProbeReply is what `pm2 --probe` prints: proof that this agent image has the pm2 subcommand.
const PM2ProbeReply = "tugra-pm2-v1"

// PM2FactsVersion is the schema version of the facts document (the hub rejects a different one).
const PM2FactsVersion = 1

const maxEnvOut = 36000 // bytes of environment values one --env reply may carry (the helper's stdout is capped at 48 KB)

// PM2Facts is the document `pm2` prints.
type PM2Facts struct {
	V      int            `json:"v"`
	Users  []PM2FactsUser `json:"users"`
	Errors []string       `json:"errors"`
}

// PM2FactsUser is one PM2 home.
type PM2FactsUser struct {
	User   string    `json:"user"`
	Home   string    `json:"home"`
	UID    int       `json:"uid"` // owner of the PM2 home = the account that runs the daemon
	GID    int       `json:"gid"`
	Daemon bool      `json:"daemon"`
	Procs  []PM2Fact `json:"procs"`
}

// PM2Fact is everything the planner needs about one saved PM2 process.
type PM2Fact struct {
	Name            string            `json:"name"`
	NameExact       bool              `json:"nameExact"` // the saved name had no control characters and fit the cap (so it can be passed to pm2 verbatim)
	Status          string            `json:"status"`    // online | stopped
	Script          string            `json:"script,omitempty"`
	Cwd             string            `json:"cwd,omitempty"`
	Interpreter     string            `json:"interpreter,omitempty"` // exec_interpreter as saved: "node", "none", "python3", an absolute path
	Mode            string            `json:"mode,omitempty"`        // fork | cluster
	Instances       int               `json:"instances,omitempty"`   // entries with this name (cluster workers are saved one per entry)
	ArgsOverflow    bool              `json:"argsOverflow"`          // an argument list was cut (too many / too long): the planner must not guess
	Args            []string          `json:"args"`
	NodeArgs        []string          `json:"nodeArgs"`
	InterpreterArgs []string          `json:"interpreterArgs"`
	UID             *int              `json:"uid,omitempty"` // an explicit uid/gid of the process (dump "uid"/"gid"), when it has one
	GID             *int              `json:"gid,omitempty"`
	Port            int               `json:"port,omitempty"`
	EnvCount        int               `json:"envCount"`
	EnvSkipped      int               `json:"envSkipped"` // entries left out (nested objects, arrays, PM2 internals, host-shell noise)
	EnvDigest       string            `json:"envDigest"`  // sha256 of the carried environment (sorted KEY=VALUE lines)
	Env             map[string]string `json:"env,omitempty"`
	NvmRC           string            `json:"nvmrc,omitempty"`
	EnginesNode     string            `json:"enginesNode,omitempty"`
	CwdExists       bool              `json:"cwdExists"`
	ScriptExists    bool              `json:"scriptExists"`
	CwdUID          int               `json:"cwdUid"`
	CwdGID          int               `json:"cwdGid"`
}

// PM2Options selects what to read.
type PM2Options struct {
	Root    string
	Proc    string
	User    string // empty = every home
	Name    string // empty = every process (requires User when WithEnv)
	WithEnv bool
}

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,255}$`)

// pm2InternalEnv are the keys PM2 itself writes next to the application's environment in a saved process.
var pm2InternalEnv = map[string]bool{
	"name": true, "namespace": true, "script": true, "args": true, "exec_interpreter": true, "cwd": true,
	"pm_exec_path": true, "pm_cwd": true, "pm_out_log_path": true, "pm_err_log_path": true, "pm_pid_path": true,
	"exec_mode": true, "instances": true, "node_args": true, "interpreter_args": true, "status": true, "pm_id": true,
	"restart_time": true, "unstable_restarts": true, "created_at": true, "pm_uptime": true, "vizion": true,
	"vizion_running": true, "versioning": true, "automation": true, "treekill": true, "autorestart": true,
	"watch": true, "merge_logs": true, "instance_var": true, "unique_id": true, "km_link": true, "pmx": true,
	"username": true, "windowsHide": true, "kill_retry_time": true, "kill_timeout": true, "listen_timeout": true,
	"restart_delay": true, "max_restarts": true, "min_uptime": true, "exp_backoff_restart_delay": true,
	"increment_var": true, "filter_env": true, "source_map_support": true, "disable_source_map_support": true,
	"uid": true, "gid": true, "version": true, "wait_ready": true, "time": true, "log_date_format": true,
	"out_file": true, "error_file": true, "pid_file": true, "append_env_to_name": true, "NODE_APP_INSTANCE": true,
	"max_memory_restart": true, "cron_restart": true, "stop_exit_codes": true, "shutdown_with_message": true,
}

// shellNoiseEnv are variables of the shell session that started PM2, meaningless (or wrong) inside a container.
var shellNoiseEnv = map[string]bool{
	"PATH": true, "PWD": true, "OLDPWD": true, "SHLVL": true, "_": true, "TERM": true, "LS_COLORS": true,
	"MAIL": true, "INVOCATION_ID": true, "JOURNAL_STREAM": true, "MANPATH": true, "INFOPATH": true,
	"LESSOPEN": true, "LESSCLOSE": true, "LESS": true, "COLORTERM": true, "NODE_PATH": true,
}

func envDropped(k string) bool {
	if pm2InternalEnv[k] || shellNoiseEnv[k] {
		return true
	}
	for _, p := range []string{"PM2_", "pm_", "axm_", "NVM_", "SSH_", "XDG_", "DBUS_", "TERM_PROGRAM", "LC_"} {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	return false
}

// filterEnv keeps the scalar application variables of a saved environment: strings, numbers and booleans under a valid
// name, minus PM2's own bookkeeping and the starting shell's session noise. Returns the kept map and how many entries
// were left out.
func filterEnv(raw map[string]any) (map[string]string, int) {
	out := map[string]string{}
	skipped := 0
	for k, v := range raw {
		if !envKeyRe.MatchString(k) || envDropped(k) {
			skipped++
			continue
		}
		switch t := v.(type) {
		case string:
			out[k] = t
		case float64:
			out[k] = strconv.FormatFloat(t, 'f', -1, 64)
		case bool:
			out[k] = strconv.FormatBool(t)
		default:
			skipped++
		}
	}
	return out, skipped
}

func envDigest(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, k := range keys {
		_, _ = io.WriteString(h, k+"="+env[k]+"\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

// hasControl reports a control character (the ones a path, name or argument must never carry into a command line).
func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// exactPath returns p unchanged when it is a usable path, else "" (never a cut or re-spaced path: a wrong directory
// must not look like a right one).
func exactPath(p string) string {
	if len(p) > 1024 || hasControl(p) {
		return ""
	}
	return p
}

// stringList reads a saved argument vector, which PM2 stores either as an array or as one string. Arguments are
// kept byte for byte; the second result is true when the list had to be cut (too many or too long).
func stringList(raw json.RawMessage, maxItems, maxLen int) ([]string, bool) {
	out := []string{}
	if len(raw) == 0 {
		return out, false
	}
	var arr []any
	if json.Unmarshal(raw, &arr) == nil {
		for _, a := range arr {
			var s string
			switch t := a.(type) {
			case string:
				s = t
			case float64:
				s = strconv.FormatFloat(t, 'f', -1, 64)
			default:
				continue
			}
			if len(out) >= maxItems || len(s) > maxLen {
				return out, true
			}
			out = append(out, s)
		}
		return out, false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return splitArgs(s, maxItems, maxLen)
	}
	return out, false
}

// splitArgs splits a saved argument string the way a shell would for plain words and quoted words (no expansion).
func splitArgs(s string, maxItems, maxLen int) ([]string, bool) {
	out := []string{}
	var cur strings.Builder
	var quote rune
	have := false
	over := false
	flush := func() {
		if !have {
			return
		}
		if len(out) >= maxItems || cur.Len() > maxLen {
			over = true
		} else {
			out = append(out, cur.String())
		}
		cur.Reset()
		have = false
	}
	for _, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote = r
			have = true
		case r == ' ' || r == '\t' || r == '\n':
			flush()
		default:
			cur.WriteRune(r)
			have = true
		}
	}
	flush()
	return out, over
}

func (f rootFS) owner(hostPath string) (uid, gid int, ok bool) {
	p, err := f.resolve(hostPath)
	if err != nil {
		return 0, 0, false
	}
	fi, err := os.Stat(p)
	if err != nil {
		return 0, 0, false
	}
	st, isSys := fi.Sys().(*syscall.Stat_t)
	if !isSys {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}

// idOf reads a saved uid/gid: a number, a numeric string, or (for uid) an account name resolved in the host's passwd.
func idOf(fs rootFS, raw json.RawMessage, file string) *int {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if s == "" || s == "null" {
		return nil
	}
	if n, err := strconv.Atoi(s); err == nil && n >= 0 && n < 1<<31 {
		return &n
	}
	b, err := fs.readFile(file)
	if err != nil {
		return nil
	}
	col := 2 // passwd: name:x:UID:GID, group: name:x:GID
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Split(line, ":")
		if len(f) > col && f[0] == s {
			if n, err := strconv.Atoi(f[col]); err == nil {
				return &n
			}
		}
	}
	return nil
}

func firstLine(b []byte, max int) string {
	s := string(b)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	return clean(s, max)
}

// enginesNode reads package.json's engines.node, if any.
func enginesNode(b []byte) string {
	var pkg struct {
		Engines struct {
			Node json.RawMessage `json:"node"`
		} `json:"engines"`
	}
	if json.Unmarshal(b, &pkg) != nil {
		return ""
	}
	var s string
	if json.Unmarshal(pkg.Engines.Node, &s) != nil {
		return ""
	}
	return clean(s, 60)
}

type rawProc struct {
	Name            string          `json:"name"`
	ExecPath        string          `json:"pm_exec_path"`
	Script          string          `json:"script"`
	Cwd             string          `json:"pm_cwd"`
	Cwd2            string          `json:"cwd"`
	ExecMode        string          `json:"exec_mode"`
	Instances       json.RawMessage `json:"instances"`
	Interpreter     string          `json:"exec_interpreter"`
	Args            json.RawMessage `json:"args"`
	NodeArgs        json.RawMessage `json:"node_args"`
	InterpreterArgs json.RawMessage `json:"interpreter_args"`
	UID             json.RawMessage `json:"uid"`
	GID             json.RawMessage `json:"gid"`
	Env             map[string]any  `json:"env"`
}

// CollectPM2Facts reads the PM2 homes described by o.
func CollectPM2Facts(o PM2Options) PM2Facts {
	if o.Root == "" {
		o.Root = "/host"
	}
	if o.Proc == "" {
		o.Proc = "/proc"
	}
	fs := newRootFS(o.Root)
	out := PM2Facts{V: PM2FactsVersion, Users: []PM2FactsUser{}, Errors: []string{}}
	type home struct{ user, home string }
	var homes []home
	if fs.isDir("/root/.pm2") {
		homes = append(homes, home{"root", "/root"})
	}
	if names, err := fs.readDir("/home"); err == nil {
		for _, n := range names {
			if len(homes) >= maxPM2Users {
				break
			}
			if fs.isDir(path.Join("/home", n, ".pm2")) {
				homes = append(homes, home{clean(n, 64), path.Join("/home", n)})
			}
		}
	}
	for _, h := range homes {
		if o.User != "" && h.user != o.User {
			continue
		}
		pm2Dir := path.Join(h.home, ".pm2")
		u := PM2FactsUser{User: h.user, Home: h.home, Procs: []PM2Fact{}}
		if uid, gid, ok := fs.owner(pm2Dir); ok {
			u.UID, u.GID = uid, gid
		}
		u.Daemon = pidAlive(o.Proc, readPid(fs, path.Join(pm2Dir, "pm2.pid")))
		live := livePids(fs, o.Proc, path.Join(pm2Dir, "pids"))
		procs, err := readFacts(fs, path.Join(pm2Dir, "dump.pm2"), live, o)
		if err != nil && !os.IsNotExist(err) {
			out.Errors = append(out.Errors, "pm2:dump")
		}
		if len(procs) > maxPM2PerUser {
			procs = procs[:maxPM2PerUser]
		}
		u.Procs = procs
		if u.Daemon || len(u.Procs) > 0 {
			out.Users = append(out.Users, u)
		}
	}
	return out
}

func readFacts(fs rootFS, p string, live map[string]bool, o PM2Options) ([]PM2Fact, error) {
	b, err := fs.readFile(p)
	if err != nil {
		return nil, err
	}
	var raw []rawProc
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	out := []PM2Fact{}
	byName := map[string]int{}
	for _, r := range raw {
		name := clean(r.Name, 120)
		if name == "" {
			continue
		}
		if i, dup := byName[name]; dup {
			out[i].Instances++
			continue
		}
		if o.Name != "" && name != o.Name {
			continue
		}
		f := PM2Fact{Name: name, NameExact: name == r.Name, Status: "stopped", Instances: 1}
		if live[name] {
			f.Status = "online"
		}
		f.Script = exactPath(firstNonEmpty(r.ExecPath, r.Script))
		f.Cwd = exactPath(firstNonEmpty(r.Cwd, r.Cwd2))
		f.Interpreter = exactPath(r.Interpreter)
		switch {
		case strings.HasPrefix(r.ExecMode, "cluster"):
			f.Mode = "cluster"
		case r.ExecMode != "":
			f.Mode = "fork"
		}
		// A cluster process saved with "instances": N is one entry per worker. An explicit number wins when larger.
		if n, err := strconv.Atoi(strings.Trim(string(r.Instances), `"`)); err == nil && n > f.Instances && n < 1024 {
			f.Instances = n
		}
		var o1, o2, o3 bool
		f.Args, o1 = stringList(r.Args, 64, 2000)
		f.NodeArgs, o2 = stringList(r.NodeArgs, 32, 2000)
		f.InterpreterArgs, o3 = stringList(r.InterpreterArgs, 32, 2000)
		f.ArgsOverflow = o1 || o2 || o3
		f.UID = idOf(fs, r.UID, "/etc/passwd")
		f.GID = idOf(fs, r.GID, "/etc/group")
		env, skipped := filterEnv(r.Env)
		f.EnvCount = len(env)
		f.EnvSkipped = skipped
		f.EnvDigest = envDigest(env)
		if v, ok := env["PORT"]; ok {
			f.Port = validPort(v)
		}
		if o.WithEnv {
			f.Env = env
		}
		if f.Cwd != "" && strings.HasPrefix(f.Cwd, "/") {
			f.CwdExists = fs.isDir(f.Cwd)
			if uid, gid, ok := fs.owner(f.Cwd); ok {
				f.CwdUID, f.CwdGID = uid, gid
			}
			if f.CwdExists {
				if nb, err := fs.readFile(path.Join(f.Cwd, ".nvmrc")); err == nil {
					f.NvmRC = firstLine(nb, 40)
				}
				if pb, err := fs.readFile(path.Join(f.Cwd, "package.json")); err == nil {
					f.EnginesNode = enginesNode(pb)
				}
			}
		}
		if strings.HasPrefix(f.Script, "/") {
			f.ScriptExists = fs.exists(f.Script)
		}
		byName[name] = len(out)
		out = append(out, f)
	}
	return out, nil
}

// RunPM2CLI is the `pm2` subcommand: flags --root, --proc, --user, --name, --env (and --probe). One JSON document on stdout.
// --env requires both --user and --name: an environment is only ever read out for one named process.
func RunPM2CLI(args []string, stdout, stderr io.Writer) int {
	o := PM2Options{Root: "/host", Proc: "/proc"}
	for _, a := range args {
		if a == "--probe" {
			_, _ = io.WriteString(stdout, PM2ProbeReply+"\n")
			return 0
		}
		if a == "--env" {
			o.WithEnv = true
			continue
		}
		k, v, ok := strings.Cut(a, "=")
		if !ok {
			continue
		}
		switch k {
		case "--root":
			o.Root = v
		case "--proc":
			o.Proc = v
		case "--user":
			o.User = v
		case "--name":
			o.Name = v
		}
	}
	if o.WithEnv && (o.User == "" || o.Name == "") {
		_, _ = io.WriteString(stderr, "pm2: --env needs --user and --name\n")
		return 2
	}
	doc := CollectPM2Facts(o)
	b, err := json.Marshal(doc)
	if err != nil {
		_, _ = io.WriteString(stderr, "pm2: encode failed\n")
		return 1
	}
	if o.WithEnv {
		// The environment of ONE process: refuse (rather than truncate into broken JSON) when it is larger than the reply allows.
		for _, u := range doc.Users {
			for _, p := range u.Procs {
				n := 0
				for k, v := range p.Env {
					n += len(k) + len(v) + 8
				}
				if n > maxEnvOut {
					_, _ = io.WriteString(stderr, "pm2: environment too large\n")
					return 3
				}
			}
		}
	}
	if !o.WithEnv {
		// Listing form: drop whole processes (never cut JSON) until the document fits the helper's output cap.
		for len(b) > maxOutput {
			trimmed := false
			for i := len(doc.Users) - 1; i >= 0; i-- {
				if n := len(doc.Users[i].Procs); n > 0 {
					doc.Users[i].Procs = doc.Users[i].Procs[:n-1]
					trimmed = true
					break
				}
			}
			if !trimmed {
				break
			}
			doc.Errors = appendOnce(doc.Errors, "truncated")
			b, _ = json.Marshal(doc)
		}
	}
	_, _ = stdout.Write(append(b, '\n'))
	return 0
}

func appendOnce(s []string, v string) []string {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}
