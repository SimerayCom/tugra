package scan

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func link(t *testing.T, root, rel, target string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, p); err != nil {
		t.Fatal(err)
	}
}

// fakeProc builds a /proc with the given pid → comm map and net tables.
func fakeProc(t *testing.T, comms map[string]string, tcp, tcp6 string) string {
	t.Helper()
	proc := t.TempDir()
	for pid, comm := range comms {
		write(t, proc, pid+"/comm", comm+"\n")
	}
	write(t, proc, "net/tcp", tcp)
	write(t, proc, "net/tcp6", tcp6)
	return proc
}

const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

func TestRootFSResolvesLinksInsideTheMount(t *testing.T) {
	root := t.TempDir()
	write(t, root, "etc/nginx/sites-available/a.conf", "server { server_name a.example.com; }")
	// An absolute link must resolve against the mount, not the scanner's own /etc.
	link(t, root, "etc/nginx/sites-enabled/a.conf", "/etc/nginx/sites-available/a.conf")
	// A relative link that tries to climb out of the mount stays at the host root.
	link(t, root, "etc/nginx/conf.d/evil.conf", "../../../../../../../../etc/passwd")
	fs := newRootFS(root)
	b, err := fs.readFile("/etc/nginx/sites-enabled/a.conf")
	if err != nil || !strings.Contains(string(b), "a.example.com") {
		t.Fatalf("absolute link not followed in root: %v %q", err, b)
	}
	if b, err := fs.readFile("/etc/nginx/conf.d/evil.conf"); err == nil {
		t.Fatalf("a link climbing out of the root must not read the scanner's /etc/passwd, got %q", b)
	}
	if !fs.isSymlink("/etc/nginx/sites-enabled/a.conf") || fs.isSymlink("/etc/nginx/sites-available/a.conf") {
		t.Fatal("isSymlink wrong")
	}
}

func TestRootFSLinkLoopIsBounded(t *testing.T) {
	root := t.TempDir()
	link(t, root, "a", "/b")
	link(t, root, "b", "/a")
	if _, err := newRootFS(root).readFile("/a"); err == nil {
		t.Fatal("expected an error on a link loop")
	}
}

func TestReadFileIsSizeCapped(t *testing.T) {
	root := t.TempDir()
	write(t, root, "big", strings.Repeat("x", maxFile+1000))
	b, err := newRootFS(root).readFile("/big")
	if err != nil || len(b) != maxFile {
		t.Fatalf("len=%d err=%v", len(b), err)
	}
}

func TestMarkers(t *testing.T) {
	root := t.TempDir()
	write(t, root, "data/coolify/.keep", "")
	write(t, root, "usr/bin/clpctl", "")
	write(t, root, "usr/sbin/nginx", "")
	got := collectMarkers(newRootFS(root))
	want := []string{"coolify", "cloudpanel", "nginx"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPM2ReadsDumpWithoutLeakingEnv(t *testing.T) {
	root := t.TempDir()
	proc := fakeProc(t, map[string]string{"4242": "node", "100": "PM2 v5.4.2: God"}, tcpHeader, tcpHeader)
	dump := `[
	  {"name":"api","pm_exec_path":"/srv/api/server.js","pm_cwd":"/srv/api","exec_mode":"cluster_mode","instances":2,
	   "env":{"PORT":"3000","DATABASE_URL":"postgres://u:supersecret@db/x","API_KEY":"k-123"}},
	  {"name":"worker","script":"worker.js","cwd":"/srv/worker","exec_mode":"fork_mode","env":{}}
	]`
	write(t, root, "home/deploy/.pm2/dump.pm2", dump)
	write(t, root, "home/deploy/.pm2/pm2.pid", "100\n")
	write(t, root, "home/deploy/.pm2/pids/api-0.pid", "4242")
	write(t, root, "home/deploy/.pm2/pids/ghost-1.pid", "99999") // pid not alive, not in dump
	write(t, root, "home/deploy/.pm2/pids/adhoc-2.pid", "4242")  // alive, not in dump
	var errs []string
	users := collectPM2(newRootFS(root), proc, &errs)
	if len(users) != 1 || users[0].User != "deploy" || !users[0].Daemon {
		t.Fatalf("users: %+v", users)
	}
	procs := users[0].Procs
	if len(procs) != 3 {
		t.Fatalf("procs: %+v", procs)
	}
	api := procs[0]
	if api.Name != "api" || api.Status != "online" || api.Mode != "cluster" || api.Instances != 2 || api.Port != 3000 || api.EnvCount != 3 || api.Cwd != "/srv/api" {
		t.Fatalf("api: %+v", api)
	}
	if procs[1].Name != "worker" || procs[1].Status != "stopped" || procs[1].Mode != "fork" {
		t.Fatalf("worker: %+v", procs[1])
	}
	if procs[2].Name != "adhoc" || procs[2].Status != "online" {
		t.Fatalf("adhoc: %+v", procs[2])
	}
	raw, _ := json.Marshal(users)
	for _, secret := range []string{"supersecret", "DATABASE_URL", "API_KEY", "k-123"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("report leaks %q: %s", secret, raw)
		}
	}
	if len(errs) != 0 {
		t.Fatalf("errs: %v", errs)
	}
}

func TestPM2BrokenDumpIsReportedNotFatal(t *testing.T) {
	root := t.TempDir()
	proc := fakeProc(t, nil, tcpHeader, tcpHeader)
	write(t, root, "root/.pm2/dump.pm2", "{not json")
	var errs []string
	users := collectPM2(newRootFS(root), proc, &errs)
	if len(users) != 0 || len(errs) != 1 || errs[0] != "pm2:dump" {
		t.Fatalf("users=%v errs=%v", users, errs)
	}
}

const cloudpanelNginx = `
# managed by CloudPanel
server {
  listen 80;
  listen [::]:80;
  server_name www.example.com example.com;
  return 301 https://example.com$request_uri;
}
server {
  listen 443 ssl http2;
  server_name example.com;
  root /home/acme-site/htdocs/example.com;
  ssl_certificate /etc/nginx/ssl-certificates/example.com.crt;
  location ~ \.php$ {
    fastcgi_pass unix:/run/php/php8.2-fpm-acme-site.sock;
  }
}
server {
  listen 443 ssl;
  server_name app.example.com;
  root /home/acme-app/htdocs/app.example.com;
  location / { proxy_pass http://127.0.0.1:3000; }
}
server {
  listen 443 ssl;
  server_name _;
  root /home/clp/htdocs/app/files;
}
server {
  listen 80;
  server_name via-upstream.example.com;
  location / { proxy_pass http://backend/; }
}
upstream backend { server 127.0.0.1:8081; }
`

func TestSitesNginxCloudPanel(t *testing.T) {
	root := t.TempDir()
	write(t, root, "etc/nginx/sites-enabled/example.com.conf", cloudpanelNginx)
	write(t, root, "usr/bin/clpctl", "")
	var errs []string
	sites := collectSites(newRootFS(root), true, &errs)
	byName := map[string]Site{}
	for _, s := range sites {
		byName[s.Names[0]] = s
	}
	if len(sites) != 4 {
		t.Fatalf("want 4 sites (catch-all dropped, http/https merged), got %d: %+v", len(sites), sites)
	}
	php := byName["example.com"]
	if php.Kind != "php" || php.PHP != "8.2" || !php.SSL || php.Panel != "cloudpanel" || php.SiteUser != "acme-site" || php.Root != "/home/acme-site/htdocs/example.com" {
		t.Fatalf("php site: %+v", php)
	}
	app := byName["app.example.com"]
	if app.Kind != "proxy" || app.Port != 3000 || app.Panel != "cloudpanel" {
		t.Fatalf("proxy site: %+v", app)
	}
	up := byName["via-upstream.example.com"]
	if up.Kind != "proxy" || up.Port != 8081 || up.SSL || up.Panel != "" {
		t.Fatalf("upstream site: %+v", up)
	}
	if _, ok := byName["www.example.com"]; ok {
		t.Fatalf("the www redirect pair must merge into one site: %+v", sites)
	}
}

func TestSitesWithoutCloudPanelCarryNoPanel(t *testing.T) {
	root := t.TempDir()
	write(t, root, "etc/nginx/conf.d/site.conf", cloudpanelNginx)
	for _, s := range collectSites(newRootFS(root), false, new([]string)) {
		if s.Panel != "" {
			t.Fatalf("panel set without the marker: %+v", s)
		}
	}
}

func TestSitesApache(t *testing.T) {
	root := t.TempDir()
	write(t, root, "etc/apache2/sites-enabled/a.conf", `
<VirtualHost *:443>
  ServerName shop.example.com
  ServerAlias www.shop.example.com
  DocumentRoot /var/www/shop
  SSLEngine on
  SetHandler "proxy:unix:/run/php/php8.3-fpm.sock|fcgi://localhost"
</VirtualHost>
<VirtualHost *:80>
  ServerName api.example.com
  ProxyPass "/.well-known/" !
  ProxyPass / http://127.0.0.1:9000/
</VirtualHost>
<VirtualHost *:80>
  ServerName localhost
  DocumentRoot /var/www/html
</VirtualHost>
`)
	sites := collectSites(newRootFS(root), false, new([]string))
	if len(sites) != 2 {
		t.Fatalf("sites: %+v", sites)
	}
	for _, s := range sites {
		switch s.Names[0] {
		case "shop.example.com":
			if s.Kind != "php" || s.PHP != "8.3" || !s.SSL || len(s.Names) != 2 || s.Server != "apache" {
				t.Fatalf("shop: %+v", s)
			}
		case "api.example.com":
			if s.Kind != "proxy" || s.Port != 9000 {
				t.Fatalf("api: %+v", s)
			}
		default:
			t.Fatalf("unexpected %+v", s)
		}
	}
}

func TestNginxQuotedAndMalformedInputDoesNotPanic(t *testing.T) {
	for _, in := range []string{"", "server {", "}}}}", `server { server_name "a b; }`, strings.Repeat("a {", 500), "server { listen 443 ssl; server_name x.example.com }"} {
		_ = nginxSites(in)
		_ = apacheSites(in)
	}
}

func TestServices(t *testing.T) {
	root := t.TempDir()
	write(t, root, "etc/systemd/system/multi-user.target.wants/nginx.service", "")
	write(t, root, "etc/systemd/system/multi-user.target.wants/php8.2-fpm.service", "")
	write(t, root, "etc/systemd/system/multi-user.target.wants/ssh.service", "") // unrelated: ignored
	write(t, root, "etc/systemd/system/multi-user.target.wants/pm2-deploy.service", "")
	write(t, root, "etc/systemd/system/multi-user.target.wants/myapp.service", "")
	write(t, root, "etc/systemd/system/myapp.service", "[Service]\nWorkingDirectory=/srv/myapp\nExecStart=/usr/bin/node /srv/myapp/server.js --token=hunter2\n")
	write(t, root, "etc/systemd/system/backup.service", "[Service]\nExecStart=/usr/local/bin/backup.sh\n") // not an app runtime
	comms := map[string]bool{"nginx": true, "mysqld": true}
	svcs := collectServices(newRootFS(root), comms, new([]string))
	by := map[string]Service{}
	for _, s := range svcs {
		by[s.Unit] = s
	}
	if _, ok := by["ssh"]; ok {
		t.Fatal("ssh must not be reported")
	}
	if _, ok := by["backup"]; ok {
		t.Fatal("a non-runtime custom unit must not be reported")
	}
	if n := by["nginx"]; n.Kind != "web" || !n.Enabled || n.Running == nil || !*n.Running {
		t.Fatalf("nginx: %+v", n)
	}
	if p := by["php8.2-fpm"]; p.Kind != "php" || p.Running == nil || *p.Running {
		t.Fatalf("php-fpm enabled but not running: %+v", p)
	}
	if my := by["mysql"]; my.Enabled || my.Running == nil || !*my.Running {
		t.Fatalf("mysql running but not enabled: %+v", my)
	}
	if by["pm2-deploy"].Unit == "" {
		t.Fatal("pm2 unit missing")
	}
	app := by["myapp"]
	if app.Kind != "app" || app.Exec != "node" || app.WorkDir != "/srv/myapp" || !app.Enabled {
		t.Fatalf("app: %+v", app)
	}
	raw, _ := json.Marshal(svcs)
	if strings.Contains(string(raw), "hunter2") {
		t.Fatalf("ExecStart arguments leaked: %s", raw)
	}
}

func TestParseUnitExecSkipsEnvWrapper(t *testing.T) {
	exe, wd := parseUnitExec("ExecStart=-/usr/bin/env FOO=bar NODE_ENV=production node app.js\nWorkingDirectory=/x")
	if exe != "node" || wd != "/x" {
		t.Fatalf("%q %q", exe, wd)
	}
}

func TestPorts(t *testing.T) {
	tcp := tcpHeader +
		"   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000\n" + // 0.0.0.0:80
		"   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000\n" + // 127.0.0.1:3000
		"   2: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3 1 0000\n" + // 127.0.0.1:80 (also on 0.0.0.0 → public wins)
		"   3: 0A00A8C0:C350 0A00A8C1:0050 01 00000000:00000000 00:00000000 00000000     0        0 4 1 0000\n" // ESTABLISHED, ignored
	tcp6 := tcpHeader +
		"   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1 0000\n" + // [::1]:8080
		"   1: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 6 1 0000\n" // [::]:443
	proc := fakeProc(t, nil, tcp, tcp6)
	got := collectPorts(newRootFS(t.TempDir()), proc, new([]string))
	want := []Port{{80, "tcp", "public", ""}, {443, "tcp", "public", ""}, {3000, "tcp", "local", ""}, {8080, "tcp", "local", ""}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %+v want %+v", got, want)
		}
	}
}

func TestRunEndToEndAndCLI(t *testing.T) {
	root := t.TempDir()
	write(t, root, "data/coolify/x", "")
	write(t, root, "etc/nginx/sites-enabled/a.conf", "server { listen 80; server_name a.example.com; root /var/www/a; }")
	proc := fakeProc(t, map[string]string{"1": "nginx"}, tcpHeader, tcpHeader)
	var out, errb bytes.Buffer
	if code := RunCLI([]string{"--root=" + root, "--proc=" + proc}, &out, &errb); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	var r Report
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.V != Version || len(r.Markers) != 1 || r.Markers[0] != "coolify" || len(r.Sites) != 1 || r.Sites[0].Kind != "static" {
		t.Fatalf("report: %+v", r)
	}
	// Empty collections encode as [] (never null) so the hub schema stays simple.
	if !strings.Contains(out.String(), `"pm2":[]`) || !strings.Contains(out.String(), `"ports":[]`) || !strings.Contains(out.String(), `"errors":[]`) {
		t.Fatalf("empty lists must be []: %s", out.String())
	}
}

func TestRunOnAnEmptyHostIsSafe(t *testing.T) {
	r := Run(Options{Root: t.TempDir(), Proc: t.TempDir()})
	if r.V != Version || len(r.Sites) != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestCleanStripsControlAndCaps(t *testing.T) {
	if got := clean("a\x00b\n\tc\x1b[31m", 50); strings.ContainsAny(got, "\x00\n\t\x1b") {
		t.Fatalf("control chars left: %q", got)
	}
	if got := clean(strings.Repeat("é", 200), 20); len(got) > 20 {
		t.Fatalf("not capped: %d", len(got))
	}
}

func TestPM2ClusterEntriesMergeIntoOneRow(t *testing.T) {
	root := t.TempDir()
	proc := fakeProc(t, map[string]string{"4242": "node"}, tcpHeader, tcpHeader)
	entry := `{"name":"web","pm_exec_path":"/srv/web.js","exec_mode":"cluster_mode","env":{}}`
	write(t, root, "root/.pm2/dump.pm2", "["+entry+","+entry+","+entry+","+entry+"]")
	write(t, root, "root/.pm2/pids/web-0.pid", "4242")
	var errs []string
	users := collectPM2(newRootFS(root), proc, &errs)
	if len(users) != 1 || len(users[0].Procs) != 1 {
		t.Fatalf("users: %+v", users)
	}
	if p := users[0].Procs[0]; p.Name != "web" || p.Instances != 4 || p.Status != "online" {
		t.Fatalf("proc: %+v", p)
	}
}

func TestFitDropsItemsNotJSON(t *testing.T) {
	r := Report{V: Version, Markers: []string{}, PM2: []PM2User{}, Sites: []Site{}, Services: []Service{}, Ports: []Port{}, Errors: []string{}}
	for i := 0; i < 150; i++ {
		r.Sites = append(r.Sites, Site{Server: "nginx", Names: []string{strings.Repeat("a", 100) + ".example.com"}, Root: strings.Repeat("/r", 90), Kind: "php"})
	}
	out := fit(r, 20000)
	b, _ := json.Marshal(out)
	if len(b) > 20000 || len(out.Sites) == 0 || len(out.Sites) >= 150 {
		t.Fatalf("size %d sites %d", len(b), len(out.Sites))
	}
	if !hasMarker(out.Errors, "truncated") {
		t.Fatalf("errors: %v", out.Errors)
	}
	small := fit(Report{V: Version}, 20000)
	if len(small.Errors) != 0 {
		t.Fatalf("small report must be untouched: %v", small.Errors)
	}
}

func TestProbeReply(t *testing.T) {
	var out, errb strings.Builder
	if code := RunCLI([]string{"--probe"}, &out, &errb); code != 0 || strings.TrimSpace(out.String()) != ProbeReply {
		t.Fatalf("code %d out %q", code, out.String())
	}
}

func TestPortsReportTheOwningAccount(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	passwd := "root:x:0:0:root:/root:/bin/bash\nredis:x:110:111::/var/lib/redis:/usr/sbin/nologin\nmysql:x:112:113::/nonexistent:/bin/false\nBad Name:x:120:120::/:/bin/false\n"
	if err := os.WriteFile(filepath.Join(root, "etc", "passwd"), []byte(passwd), 0o644); err != nil {
		t.Fatal(err)
	}
	tcp := tcpHeader +
		"   0: 00000000:1952 00000000:0000 0A 00000000:00000000 00:00000000 00000000   110        0 1 1 0000\n" + // 0.0.0.0:6482 redis
		"   1: 00000000:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000   112        0 2 1 0000\n" + // 0.0.0.0:3306 mysql
		"   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3 1 0000\n" + // 0.0.0.0:80 root: no account reported
		"   3: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   120        0 4 1 0000\n" // 0.0.0.0:8080 odd account name: dropped
	proc := fakeProc(t, nil, tcp, tcpHeader)
	got := collectPorts(newRootFS(root), proc, new([]string))
	by := map[int]string{}
	for _, p := range got {
		by[p.Port] = p.User
	}
	if by[6482] != "redis" || by[3306] != "mysql" || by[80] != "" || by[8080] != "" {
		t.Fatalf("got %+v", got)
	}
}
