package scan

import (
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type unitInfo struct {
	kind  string
	comms []string // process names (/proc/<pid>/comm) that mean the unit is running; none = cannot tell
}

// knownUnits are the systemd units the report recognises (web servers, runtimes, databases, panels, tooling).
// Anything else is ignored, so an unrelated service never leaks into the report.
var knownUnits = map[string]unitInfo{
	"nginx":             {"web", []string{"nginx"}},
	"apache2":           {"web", []string{"apache2"}},
	"httpd":             {"web", []string{"httpd"}},
	"caddy":             {"web", []string{"caddy"}},
	"traefik":           {"web", []string{"traefik"}},
	"haproxy":           {"web", []string{"haproxy"}},
	"lighttpd":          {"web", []string{"lighttpd"}},
	"lsws":              {"web", []string{"litespeed", "openlitespeed", "lshttpd"}},
	"varnish":           {"web", []string{"varnishd"}},
	"mysql":             {"database", []string{"mysqld"}},
	"mysqld":            {"database", []string{"mysqld"}},
	"mariadb":           {"database", []string{"mariadbd", "mysqld"}},
	"postgresql":        {"database", []string{"postgres"}},
	"redis":             {"database", []string{"redis-server"}},
	"redis-server":      {"database", []string{"redis-server"}},
	"valkey":            {"database", []string{"valkey-server"}},
	"valkey-server":     {"database", []string{"valkey-server"}},
	"mongod":            {"database", []string{"mongod"}},
	"memcached":         {"database", []string{"memcached"}},
	"clickhouse-server": {"database", []string{"clickhouse-serv", "clickhouse-server"}},
	"elasticsearch":     {"database", []string{"java"}},
	"rabbitmq-server":   {"database", []string{"beam.smp"}},
	"docker":            {"runtime", []string{"dockerd"}},
	"containerd":        {"runtime", []string{"containerd"}},
	"tailscaled":        {"tool", []string{"tailscaled"}},
	"fail2ban":          {"tool", []string{"fail2ban-server"}},
	"cpanel":            {"panel", []string{"cpsrvd"}},
	"sw-cp-server":      {"panel", []string{"sw-cp-server"}},
	"directadmin":       {"panel", []string{"directadmin"}},
}

var (
	phpFpmUnitRe = regexp.MustCompile(`^php(\d+(?:\.\d+)?)?-fpm$`)
	pm2UnitRe    = regexp.MustCompile(`^pm2-[A-Za-z0-9._-]{1,40}$`)
	appExecRe    = regexp.MustCompile(`^(node|nodejs|bun|deno|npm|npx|yarn|pnpm|python[0-9.]*|gunicorn|uvicorn|hypercorn|daphne|php[0-9.]*|java|dotnet|ruby|puma|unicorn|serve|next|pm2)$`)
	unitNameRe   = regexp.MustCompile(`^[A-Za-z0-9@._:-]{1,100}$`)
)

// collectServices reads systemd's unit files (no D-Bus, no systemctl). A known unit is reported when it is enabled or
// its process is alive; custom units in /etc/systemd/system whose ExecStart is a web/app runtime are reported as apps.
func collectServices(fs rootFS, comms map[string]bool, errs *[]string) []Service {
	const etc = "/etc/systemd/system"
	enabled := map[string]bool{}
	custom := map[string]bool{}
	names, err := fs.readDir(etc)
	if err != nil {
		if !os.IsNotExist(err) {
			*errs = append(*errs, "systemd:list")
		}
		names = nil
	}
	for _, n := range names {
		switch {
		case strings.HasSuffix(n, ".wants"):
			if units, err := fs.readDir(path.Join(etc, n)); err == nil {
				for _, u := range units {
					if strings.HasSuffix(u, ".service") {
						enabled[strings.TrimSuffix(u, ".service")] = true
					}
				}
			}
		case strings.HasSuffix(n, ".service") && !fs.isSymlink(path.Join(etc, n)):
			custom[strings.TrimSuffix(n, ".service")] = true
		}
	}

	out := []Service{}
	seen := map[string]bool{}
	add := func(s Service) {
		if seen[s.Unit] || len(out) >= maxServices {
			return
		}
		seen[s.Unit] = true
		out = append(out, s)
	}

	units := make([]string, 0, len(enabled))
	for u := range enabled {
		units = append(units, u)
	}
	sort.Strings(units)
	for _, u := range units {
		if !unitNameRe.MatchString(u) {
			continue
		}
		info, ok := knownUnits[u]
		if !ok {
			if m := phpFpmUnitRe.FindStringSubmatch(u); m != nil {
				info = unitInfo{"php", phpFpmComms(m[1])}
				ok = true
			} else if pm2UnitRe.MatchString(u) {
				info, ok = unitInfo{"tool", nil}, true
			}
		}
		if !ok {
			continue
		}
		add(Service{Unit: u, Kind: info.kind, Enabled: true, Running: runningOf(info.comms, comms)})
	}
	// A known service that is running but not enabled via a *.wants link (socket activation, manual start).
	known := make([]string, 0, len(knownUnits))
	for u := range knownUnits {
		known = append(known, u)
	}
	sort.Strings(known)
	for _, u := range known {
		info := knownUnits[u]
		if enabled[u] || seen[u] {
			continue
		}
		if r := runningOf(info.comms, comms); r != nil && *r {
			add(Service{Unit: u, Kind: info.kind, Enabled: false, Running: r})
		}
	}
	// Custom app units.
	cs := make([]string, 0, len(custom))
	for u := range custom {
		cs = append(cs, u)
	}
	sort.Strings(cs)
	for _, u := range cs {
		if !unitNameRe.MatchString(u) || seen[u] {
			continue
		}
		b, err := fs.readFile(path.Join(etc, u+".service"))
		if err != nil {
			continue
		}
		exe, wd := parseUnitExec(string(b))
		if exe == "" || !appExecRe.MatchString(exe) {
			continue
		}
		add(Service{Unit: u, Kind: "app", Enabled: enabled[u], Exec: exe, WorkDir: clean(wd, 200)})
	}
	return out
}

func phpFpmComms(ver string) []string {
	if ver == "" {
		return []string{"php-fpm"}
	}
	return []string{"php-fpm" + ver, "php-fpm"}
}

func runningOf(want []string, have map[string]bool) *bool {
	if len(want) == 0 {
		return nil
	}
	r := false
	for _, w := range want {
		if have[w] {
			r = true
			break
		}
	}
	return &r
}

// parseUnitExec returns the executable's base name (arguments are dropped: they can carry secrets) and the
// WorkingDirectory of a unit file.
func parseUnitExec(text string) (exe, workDir string) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "ExecStart=") && exe == "":
			f := strings.Fields(strings.TrimLeft(strings.TrimPrefix(line, "ExecStart="), "-@+!:"))
			for len(f) > 0 {
				base := filepath.Base(strings.Trim(f[0], `"'`))
				if base == "env" && len(f) > 1 {
					f = f[1:]
					for len(f) > 0 && (strings.Contains(f[0], "=") || strings.HasPrefix(f[0], "-")) {
						f = f[1:]
					}
					continue
				}
				exe = clean(base, 40)
				break
			}
		case strings.HasPrefix(line, "WorkingDirectory=") && workDir == "":
			workDir = strings.TrimPrefix(line, "WorkingDirectory=")
		}
	}
	return exe, workDir
}

// processNames is the set of /proc/<pid>/comm values on the host (needs the host PID namespace).
func processNames(proc string) map[string]bool {
	out := map[string]bool{}
	ents, err := os.ReadDir(proc)
	if err != nil {
		return out
	}
	n := 0
	for _, e := range ents {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		if n++; n > 8000 {
			break
		}
		b, err := os.ReadFile(filepath.Join(proc, e.Name(), "comm"))
		if err != nil {
			continue
		}
		out[strings.TrimSpace(string(b))] = true
	}
	return out
}
