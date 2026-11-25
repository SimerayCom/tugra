package scan

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func factsRoot(t *testing.T) (root, proc string) {
	t.Helper()
	root = t.TempDir()
	proc = fakeProc(t, map[string]string{"4242": "node", "100": "PM2 v5: God"}, tcpHeader, tcpHeader)
	return root, proc
}

const factsDump = `[
 {"name":"api","pm_exec_path":"/home/acme/htdocs/api.example.com/server.js","pm_cwd":"/home/acme/htdocs/api.example.com",
  "exec_mode":"fork_mode","exec_interpreter":"/home/acme/.nvm/versions/node/v20.11.1/bin/node","instances":1,
  "args":["--port","3000"],"node_args":["--max-old-space-size=512"],
  "env":{"PORT":"3000","NODE_ENV":"production","DB_PASSWORD":"s3cr3t","PATH":"/usr/bin","pm_id":0,"status":"online",
         "restart_time":3,"vizion_running":false,"SSH_CONNECTION":"1 2 3 4","NVM_DIR":"/x","nested":{"a":1},"list":[1],"bad key":"x","RETRIES":5,"DEBUG":true}},
 {"name":"worker","pm_exec_path":"/home/acme/htdocs/api.example.com/w.py","pm_cwd":"/home/acme/htdocs/api.example.com",
  "exec_mode":"fork_mode","exec_interpreter":"python3","args":"--queue \"high prio\" -v"},
 {"name":"noenv","pm_exec_path":"/home/acme/htdocs/b/app.js","pm_cwd":"/home/acme/htdocs/b","exec_mode":"fork_mode","exec_interpreter":"node"},
 {"name":"web","pm_exec_path":"/home/acme/htdocs/c/s.js","pm_cwd":"/home/acme/htdocs/c","exec_mode":"cluster_mode","instances":"max","env":{"PORT":8080}},
 {"name":"web","pm_exec_path":"/home/acme/htdocs/c/s.js","pm_cwd":"/home/acme/htdocs/c","exec_mode":"cluster_mode","env":{"PORT":8080}},
 {"name":"web","pm_exec_path":"/home/acme/htdocs/c/s.js","pm_cwd":"/home/acme/htdocs/c","exec_mode":"cluster_mode","env":{"PORT":8080}},
 {"name":"byname","pm_exec_path":"/x/y.js","pm_cwd":"/x","uid":"acme","gid":"1007","env":{}}
]`

func TestFactsParseFullProcess(t *testing.T) {
	root, proc := factsRoot(t)
	write(t, root, "home/acme/.pm2/dump.pm2", factsDump)
	write(t, root, "home/acme/.pm2/pm2.pid", "100")
	write(t, root, "home/acme/.pm2/pids/api-0.pid", "4242")
	write(t, root, "home/acme/htdocs/api.example.com/server.js", "x")
	write(t, root, "home/acme/htdocs/api.example.com/.nvmrc", "v20\nignored")
	write(t, root, "home/acme/htdocs/api.example.com/package.json", `{"engines":{"node":">=18 <23"}}`)
	write(t, root, "etc/passwd", "root:x:0:0::/root:/bin/sh\nacme:x:1001:1002::/home/acme:/bin/sh\n")

	doc := CollectPM2Facts(PM2Options{Root: root, Proc: proc})
	if len(doc.Users) != 1 || doc.Users[0].User != "acme" || doc.Users[0].Home != "/home/acme" || !doc.Users[0].Daemon {
		t.Fatalf("users: %+v", doc.Users)
	}
	by := map[string]PM2Fact{}
	for _, p := range doc.Users[0].Procs {
		by[p.Name] = p
	}
	api := by["api"]
	if api.Status != "online" || api.Mode != "fork" || api.Port != 3000 || api.Instances != 1 {
		t.Fatalf("api: %+v", api)
	}
	if strings.Join(api.Args, "|") != "--port|3000" || strings.Join(api.NodeArgs, "|") != "--max-old-space-size=512" {
		t.Fatalf("args: %+v", api)
	}
	if api.NvmRC != "v20" || api.EnginesNode != ">=18 <23" || !api.CwdExists || !api.ScriptExists {
		t.Fatalf("hints: %+v", api)
	}
	// Kept: PORT, NODE_ENV, DB_PASSWORD, RETRIES, DEBUG. Dropped: PATH, pm_id, status, restart_time, vizion_running, SSH_*, NVM_*, nested, list, bad key.
	if api.EnvCount != 5 || api.EnvSkipped != 10 {
		t.Fatalf("env counts: %d kept %d skipped", api.EnvCount, api.EnvSkipped)
	}
	if api.Env != nil {
		t.Fatal("a listing must never carry environment values")
	}
	// Python: interpreter reported, args given as one quoted string are split.
	w := by["worker"]
	if w.Interpreter != "python3" || strings.Join(w.Args, "|") != "--queue|high prio|-v" || w.Status != "stopped" {
		t.Fatalf("worker: %+v", w)
	}
	// Missing env: zero count and the digest of an empty environment, no panic.
	n := by["noenv"]
	if n.EnvCount != 0 || n.EnvDigest == "" || n.Port != 0 {
		t.Fatalf("noenv: %+v", n)
	}
	// Cluster: three saved entries are one process with 3 instances; PORT as a JSON number is read.
	web := by["web"]
	if web.Mode != "cluster" || web.Instances != 3 || web.Port != 8080 {
		t.Fatalf("web: %+v", web)
	}
	// uid by account name, gid numeric.
	b := by["byname"]
	if b.UID == nil || *b.UID != 1001 || b.GID == nil || *b.GID != 1007 {
		t.Fatalf("byname ids: %+v %+v", b.UID, b.GID)
	}
}

func TestFactsEnvOnlyForTheNamedProcessAndDigestMatches(t *testing.T) {
	root, proc := factsRoot(t)
	write(t, root, "home/acme/.pm2/dump.pm2", factsDump)
	list := CollectPM2Facts(PM2Options{Root: root, Proc: proc})
	one := CollectPM2Facts(PM2Options{Root: root, Proc: proc, User: "acme", Name: "api", WithEnv: true})
	if len(one.Users) != 1 || len(one.Users[0].Procs) != 1 {
		t.Fatalf("expected exactly the named process: %+v", one)
	}
	p := one.Users[0].Procs[0]
	if p.Env["DB_PASSWORD"] != "s3cr3t" || p.Env["RETRIES"] != "5" || p.Env["DEBUG"] != "true" || p.Env["PATH"] != "" {
		t.Fatalf("env: %v", p.Env)
	}
	var listed PM2Fact
	for _, q := range list.Users[0].Procs {
		if q.Name == "api" {
			listed = q
		}
	}
	if listed.EnvDigest != p.EnvDigest {
		t.Fatal("the listing digest must equal the digest of the env read for the move")
	}
}

func TestFactsDigestChangesWithTheEnvironment(t *testing.T) {
	a := envDigest(map[string]string{"A": "1", "B": "2"})
	b := envDigest(map[string]string{"B": "2", "A": "1"})
	c := envDigest(map[string]string{"A": "1", "B": "3"})
	if a != b || a == c {
		t.Fatal("digest must be order independent and value sensitive")
	}
}

func TestFactsRootHomeAndBrokenDump(t *testing.T) {
	root, proc := factsRoot(t)
	write(t, root, "root/.pm2/dump.pm2", "{not json")
	doc := CollectPM2Facts(PM2Options{Root: root, Proc: proc})
	if len(doc.Users) != 0 || len(doc.Errors) != 1 || doc.Errors[0] != "pm2:dump" {
		t.Fatalf("%+v", doc)
	}
	write(t, root, "root/.pm2/dump.pm2", `[{"name":"r","pm_exec_path":"/srv/r/a.js","pm_cwd":"/srv/r","exec_mode":"fork_mode"}]`)
	doc = CollectPM2Facts(PM2Options{Root: root, Proc: proc})
	if len(doc.Users) != 1 || doc.Users[0].User != "root" || doc.Users[0].Home != "/root" {
		t.Fatalf("%+v", doc)
	}
}

func TestSplitArgs(t *testing.T) {
	got := splitArgs(`a  "b c" 'd e' f"g h"i`, 10, 50)
	want := []string{"a", "b c", "d e", "fg hi"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("%q", got)
	}
}

func TestRunPM2CLI(t *testing.T) {
	root, proc := factsRoot(t)
	write(t, root, "home/acme/.pm2/dump.pm2", factsDump)

	var out, errb bytes.Buffer
	if rc := RunPM2CLI([]string{"--probe"}, &out, &errb); rc != 0 || strings.TrimSpace(out.String()) != PM2ProbeReply {
		t.Fatalf("probe: %d %q", rc, out.String())
	}
	out.Reset()
	if rc := RunPM2CLI([]string{"--root=" + root, "--proc=" + proc}, &out, &errb); rc != 0 {
		t.Fatalf("rc %d %s", rc, errb.String())
	}
	if strings.Contains(out.String(), "s3cr3t") {
		t.Fatal("the listing leaked an environment value")
	}
	var doc PM2Facts
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil || doc.V != PM2FactsVersion {
		t.Fatalf("bad json: %v", err)
	}
	// --env without a target is refused.
	out.Reset()
	if rc := RunPM2CLI([]string{"--root=" + root, "--env"}, &out, &errb); rc != 2 || out.Len() != 0 {
		t.Fatalf("--env alone must be refused, rc=%d", rc)
	}
	out.Reset()
	if rc := RunPM2CLI([]string{"--root=" + root, "--proc=" + proc, "--user=acme", "--name=api", "--env"}, &out, &errb); rc != 0 || !strings.Contains(out.String(), "s3cr3t") {
		t.Fatalf("named env read failed: rc=%d", rc)
	}
}

func TestRunPM2CLITrimsListingNeverEnv(t *testing.T) {
	root, proc := factsRoot(t)
	var parts []string
	for i := 0; i < 90; i++ {
		parts = append(parts, `{"name":"p`+strings.Repeat("x", 100)+string(rune('a'+i%26))+string(rune('a'+i/26))+`","pm_exec_path":"/home/acme/`+strings.Repeat("d", 300)+`/a.js","pm_cwd":"/home/acme/`+strings.Repeat("d", 300)+`","exec_mode":"fork_mode"}`)
	}
	write(t, root, "home/acme/.pm2/dump.pm2", "["+strings.Join(parts, ",")+"]")
	var out, errb bytes.Buffer
	if rc := RunPM2CLI([]string{"--root=" + root, "--proc=" + proc}, &out, &errb); rc != 0 {
		t.Fatal(errb.String())
	}
	if out.Len() > maxOutput+10 {
		t.Fatalf("listing exceeds the helper's cap: %d", out.Len())
	}
	var doc PM2Facts
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("trimmed output must stay valid JSON: %v", err)
	}
	if !strings.Contains(strings.Join(doc.Errors, ","), "truncated") {
		t.Fatal("a trimmed listing must say so")
	}
}

func TestFactsOwnerReadsRealStat(t *testing.T) {
	root, proc := factsRoot(t)
	write(t, root, "home/acme/.pm2/dump.pm2", `[{"name":"a","pm_exec_path":"`+root+`","pm_cwd":"/home/acme/app","exec_mode":"fork_mode"}]`)
	if err := os.MkdirAll(root+"/home/acme/app", 0o755); err != nil {
		t.Fatal(err)
	}
	doc := CollectPM2Facts(PM2Options{Root: root, Proc: proc})
	p := doc.Users[0].Procs[0]
	if !p.CwdExists || p.CwdUID != os.Getuid() {
		t.Fatalf("cwd owner not read: %+v (want uid %d)", p, os.Getuid())
	}
	if doc.Users[0].UID != os.Getuid() {
		t.Fatalf("pm2 home owner not read: %d", doc.Users[0].UID)
	}
}
