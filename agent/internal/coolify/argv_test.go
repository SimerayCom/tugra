package coolify

import (
	"os"
	"os/exec"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const goodPub = "HJ/Yj0VgbZMqgMcYJK4VHRXXPnfeOOjgAIUuYU+ucBk="

// The helper's command line, character for character. Any change to the sandbox flags is a deliberate edit of this test.
func TestHelperArgvGolden(t *testing.T) {
	got, err := HelperArgv("ghcr.io/example/agent:1.0", "tugra-coolify-open-0123456789abcdef", "run-1", "srv-1", goodPub)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"docker", "run", "--rm", "-i", "--name", "tugra-coolify-open-0123456789abcdef",
		"--network", "none", "--read-only", "--cap-drop", "ALL",
		"--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "128m",
		"--pull=never", "--log-driver", "none",
		"--entrypoint", "tugra-agent", "ghcr.io/example/agent:1.0", "coolify-open",
		"--run=run-1", "--server=srv-1", "--recipient=" + goodPub,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("helper argv drifted:\n got %q\nwant %q", got, want)
	}
}

func TestHelperArgvHasNoWayOutOfTheSandbox(t *testing.T) {
	argv, _ := HelperArgv("img:1", "tugra-coolify-open-0123456789abcdef", "run-1", "srv-1", goodPub)
	joined := " " + strings.Join(argv, " ") + " "
	for _, bad := range []string{" -v ", " --volume", " --mount", " -e ", " --env", " --env-file", " --privileged", " --net host", " --network host", " --network=host", " --pid ", " --pid=", " --ipc", " --uts", " --userns", " --device", " --cap-add", "docker.sock", " --security-opt seccomp=unconfined", " --security-opt apparmor=unconfined", " --add-host", " -p ", " --publish", " --user root", " --pull=always", " --pull always"} {
		if strings.Contains(joined, bad) {
			t.Errorf("helper argv contains %q: %s", bad, joined)
		}
	}
	for _, must := range []string{" --network none ", " --read-only ", " --cap-drop ALL ", " --security-opt no-new-privileges ", " --pull=never ", " --rm ", " --pids-limit 32 ", " --memory 128m "} {
		if !strings.Contains(joined, must) {
			t.Errorf("helper argv lacks %q", must)
		}
	}
	// No secret is ever on argv: the only per-run values are the ids and the PUBLIC recipient key.
	for _, a := range argv {
		if strings.Contains(a, "APP_KEY") || strings.Contains(a, "base64:") {
			t.Errorf("suspicious argv element %q", a)
		}
	}
}

func TestHelperArgvValidation(t *testing.T) {
	name := "tugra-coolify-open-0123456789abcdef"
	cases := map[string][5]string{
		"empty image":     {"", name, "r", "s", goodPub},
		"dash image":      {"-v", name, "r", "s", goodPub},
		"space in image":  {"img --privileged", name, "r", "s", goodPub},
		"bad name":        {"img", "x; rm -rf /", "r", "s", goodPub},
		"bad run":         {"img", name, "r --x", "s", goodPub},
		"bad server":      {"img", name, "r", "--s", goodPub},
		"short recipient": {"img", name, "r", "s", "AAAA"},
		"recipient flag":  {"img", name, "r", "s", "--privileged"},
	}
	for n, c := range cases {
		if a, err := HelperArgv(c[0], c[1], c[2], c[3], c[4]); err == nil {
			t.Errorf("%s accepted: %q", n, a)
		}
	}
	if _, err := RemoveArgv("anything"); err == nil {
		t.Error("RemoveArgv must only take a helper container name")
	}
	if a, err := RemoveArgv(name); err != nil || !reflect.DeepEqual(a, []string{"docker", "rm", "-f", name}) {
		t.Errorf("RemoveArgv: %q %v", a, err)
	}
}

func TestPsqlAndKeyArgvGolden(t *testing.T) {
	wantPsql := []string{"docker", "exec", "-i", "-e", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20000 -c idle_in_transaction_session_timeout=20000", "coolify-db", "sh", "-c", `exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"`}
	if got := PsqlArgv(); !reflect.DeepEqual(got, wantPsql) {
		t.Fatalf("psql argv drifted: %q", got)
	}
	k := KeyArgv()
	if len(k) != 6 || !reflect.DeepEqual(k[:5], []string{"docker", "exec", "coolify", "sh", "-c"}) {
		t.Fatalf("key argv: %q", k)
	}
	// The key script only READS: no write redirect, no network tool, no echo of the value into a file.
	for _, bad := range []string{">", "curl", "wget", "nc ", "tee", "docker", "env |", "set -x"} {
		if strings.Contains(strings.ReplaceAll(k[5], "2>/dev/null", ""), bad) {
			t.Errorf("key script contains %q", bad)
		}
	}
	// Neither carries any value: the argv has no secret to leak (SQL and key go over stdin / stdout).
	if len(PsqlArgv()) != len(wantPsql) {
		t.Fatal("psql argv must be constant")
	}
}

// The helper's code (laravel, seal, open) must never be able to reach the network or start a process: its dependency closure is checked
// with the Go tool itself, so an import added later fails here.
func TestHelperDependencyClosureHasNoNetworkOrProcess(t *testing.T) {
	if testing.Short() {
		t.Skip("runs the go tool")
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go tool not available")
	}
	out, err := exec.Command(goBin, "list", "-deps", "./open").CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}
	deps := strings.Fields(string(out))
	banned := regexp.MustCompile(`^(net|net/.*|os/exec|os/user|plugin|syscall/js|crypto/tls|crypto/x509|golang.org/x/net/.*|github.com/.*)$`)
	var bad []string
	for _, d := range deps {
		if strings.HasPrefix(d, "github.com/SimerayCom/tugra/agent/internal/coolify/") {
			continue
		}
		if banned.MatchString(d) {
			bad = append(bad, d)
		}
	}
	sort.Strings(bad)
	if len(bad) > 0 {
		t.Fatalf("the sealed-secrets helper pulls in %v", bad)
	}
	// And only the three packages of the helper from this repository.
	for _, d := range deps {
		if strings.HasPrefix(d, "github.com/SimerayCom/tugra/") && !strings.Contains(d, "/internal/coolify/") {
			t.Errorf("the helper depends on %s", d)
		}
	}
}

// The helper's source must not name a path, an env var or a socket either.
func TestHelperSourceDoesNotTouchFilesOrEnvironment(t *testing.T) {
	for _, dir := range []string{"open", "laravel", "seal"} {
		ents, _ := os.ReadDir(dir)
		for _, e := range ents {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			src, _ := os.ReadFile(dir + "/" + e.Name())
			for _, bad := range []string{"os.Getenv", "os.Environ", "os.OpenFile", "os.Create", "os.WriteFile", "os.ReadFile", "ioutil", "net.Dial", "http."} {
				if strings.Contains(string(src), bad) {
					t.Errorf("%s/%s uses %s", dir, e.Name(), bad)
				}
			}
		}
	}
}
