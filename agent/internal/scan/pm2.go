package scan

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var pidFileRe = regexp.MustCompile(`^(.+)-(\d+)\.pid$`)

// collectPM2 reads every account's PM2 home (/root/.pm2 and /home/*/.pm2) WITHOUT running pm2: `pm2 jlist` would
// start a daemon when none is running, which a read-only scan must never do. The state comes from the files PM2
// itself keeps: dump.pm2 (the saved process list), pids/<name>-<id>.pid (one per live process) and pm2.pid (the daemon).
func collectPM2(fs rootFS, proc string, errs *[]string) []PM2User {
	type home struct{ user, dir string }
	var homes []home
	if fs.isDir("/root/.pm2") {
		homes = append(homes, home{"root", "/root/.pm2"})
	}
	if names, err := fs.readDir("/home"); err == nil {
		for _, n := range names {
			if len(homes) >= maxPM2Users {
				break
			}
			if fs.isDir(path.Join("/home", n, ".pm2")) {
				homes = append(homes, home{clean(n, 64), path.Join("/home", n, ".pm2")})
			}
		}
	}
	out := []PM2User{}
	for _, h := range homes {
		u := PM2User{User: h.user, Procs: []PM2Proc{}}
		u.Daemon = pidAlive(proc, readPid(fs, path.Join(h.dir, "pm2.pid")))
		live := livePids(fs, proc, path.Join(h.dir, "pids"))
		procs, err := readDump(fs, path.Join(h.dir, "dump.pm2"), live)
		if err != nil && !os.IsNotExist(err) {
			*errs = append(*errs, "pm2:dump")
		}
		// A live process that is not in the dump (never `pm2 save`d) is still worth reporting, by name.
		seen := map[string]bool{}
		for _, p := range procs {
			seen[p.Name] = true
		}
		var extra []string
		for name := range live {
			if !seen[name] {
				extra = append(extra, name)
			}
		}
		sort.Strings(extra)
		for _, name := range extra {
			procs = append(procs, PM2Proc{Name: name, Status: "online"})
		}
		if len(procs) > maxPM2PerUser {
			procs = procs[:maxPM2PerUser]
		}
		u.Procs = procs
		if u.Daemon || len(u.Procs) > 0 {
			out = append(out, u)
		}
	}
	return out
}

func readPid(fs rootFS, p string) int {
	b, err := fs.readFile(p)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func pidAlive(proc string, pid int) bool {
	if pid <= 0 {
		return false
	}
	_, err := os.Stat(filepath.Join(proc, strconv.Itoa(pid)))
	return err == nil
}

// livePids maps a process name to true for every pids/<name>-<id>.pid whose pid is alive.
func livePids(fs rootFS, proc, dir string) map[string]bool {
	live := map[string]bool{}
	names, err := fs.readDir(dir)
	if err != nil {
		return live
	}
	for _, n := range names {
		m := pidFileRe.FindStringSubmatch(n)
		if m == nil {
			continue
		}
		if pidAlive(proc, readPid(fs, path.Join(dir, n))) {
			live[clean(m[1], 120)] = true
		}
	}
	return live
}

// readDump parses dump.pm2. Only structure is kept: the environment map is reduced to its size (plus a numeric PORT),
// so no secret value ever leaves the host.
func readDump(fs rootFS, p string, live map[string]bool) ([]PM2Proc, error) {
	b, err := fs.readFile(p)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Name      string          `json:"name"`
		ExecPath  string          `json:"pm_exec_path"`
		Script    string          `json:"script"`
		Cwd       string          `json:"pm_cwd"`
		Cwd2      string          `json:"cwd"`
		ExecMode  string          `json:"exec_mode"`
		Instances json.RawMessage `json:"instances"`
		Env       map[string]any  `json:"env"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	out := []PM2Proc{}
	for _, r := range raw {
		name := clean(r.Name, 120)
		if name == "" {
			continue
		}
		p := PM2Proc{Name: name, Status: "stopped"}
		if live[name] {
			p.Status = "online"
		}
		p.Script = clean(firstNonEmpty(r.ExecPath, r.Script), 200)
		p.Cwd = clean(firstNonEmpty(r.Cwd, r.Cwd2), 200)
		switch {
		case strings.HasPrefix(r.ExecMode, "cluster"):
			p.Mode = "cluster"
		case r.ExecMode != "":
			p.Mode = "fork"
		}
		if n, err := strconv.Atoi(strings.Trim(string(r.Instances), `"`)); err == nil && n > 0 && n < 1024 {
			p.Instances = n
		}
		p.EnvCount = len(r.Env)
		if v, ok := r.Env["PORT"]; ok {
			switch t := v.(type) {
			case string:
				p.Port = validPort(t)
			case float64:
				p.Port = validPort(strconv.Itoa(int(t)))
			}
		}
		out = append(out, p)
	}
	return out, nil
}

func validPort(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 1 || n > 65535 {
		return 0
	}
	return n
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
