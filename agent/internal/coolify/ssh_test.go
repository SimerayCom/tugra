package coolify

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os/exec"
	"strings"
	"testing"
)

const (
	tImage = "ghcr.io/simeraycom/tugra-agent@sha256:" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	tName  = "tugra-cssh-0123456789ab"
	tUUID  = "abc123def456ghi789jkl012"
	tToken = "tugra_en_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
	tCID   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

var tKnown = tUUID + " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

var tTarget = Target{UUID: tUUID, Host: "203.0.113.7", Port: 22, User: "root", KeyUUID: "key1abcdef12"}

func has(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}

func joined(a []string) string { return strings.Join(a, " ") }

// ---- target resolution ---------------------------------------------------------------------------------------------------------

func TestTargetSQLOnlyEmbedsAValidatedUUIDAndNeverSelectsKeyContent(t *testing.T) {
	sql, err := TargetSQL(tUUID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "'"+tUUID+"'") {
		t.Fatal("uuid not in the query")
	}
	// The only private_keys column read is its uuid (a file name).
	if strings.Contains(sql, "pk.private_key") || strings.Contains(sql, "private_key,") || strings.Contains(sql, "pk.*") {
		t.Fatal("the query must not read key content")
	}
	if !strings.Contains(sql, "pk.uuid") {
		t.Fatal("the query must read the key's uuid")
	}
	for _, bad := range []string{"", "x", "ABC123DEF456", "abc'; drop table servers; --", "abc123def456\n", "-oProxyCommand=x", "a/b/c/d/e/f"} {
		if _, err := TargetSQL(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func row(id, ip, port, user, key, hk, tunnel, jump string) string {
	return `{"id":` + id + `,"ip":"` + ip + `","port":` + port + `,"user":"` + user + `","keyUuid":"` + key + `","hostKey":"` + hk + `","tunnel":"` + tunnel + `","jump":"` + jump + `"}`
}

func TestParseTarget(t *testing.T) {
	good, err := ParseTarget(tUUID, row("3", "203.0.113.7", "2222", "deploy", "key1abcdef12", "", "false", "false"))
	if err != nil || good.Host != "203.0.113.7" || good.Port != 2222 || good.User != "deploy" || good.KeyUUID != "key1abcdef12" {
		t.Fatalf("%+v %v", good, err)
	}
	cases := []struct {
		name, out, code string
	}{
		{"unknown server", "", "bad_target"},
		{"coolify's own localhost", row("0", "host.docker.internal", "22", "root", "key1abcdef12", "", "false", "false"), "bad_target"},
		{"loopback", row("3", "127.0.0.1", "22", "root", "key1abcdef12", "", "false", "false"), "bad_target"},
		{"metadata address", row("3", "169.254.169.254", "22", "root", "key1abcdef12", "", "false", "false"), "bad_target"},
		{"dash host", row("3", "-oProxyCommand=id", "22", "root", "key1abcdef12", "", "false", "false"), "bad_target"},
		{"dash user", row("3", "203.0.113.7", "22", "-oProxyCommand=id", "key1abcdef12", "", "false", "false"), "bad_target"},
		{"bad port", row("3", "203.0.113.7", "70000", "root", "key1abcdef12", "", "false", "false"), "bad_target"},
		{"no key", row("3", "203.0.113.7", "22", "root", "", "", "false", "false"), "no_key_file"},
		{"tunnel", row("3", "203.0.113.7", "22", "root", "key1abcdef12", "", "true", "false"), "unsupported_proxy"},
		{"jump", row("3", "203.0.113.7", "22", "root", "key1abcdef12", "", "false", "true"), "unsupported_proxy"},
		{"junk", "not json", "bad_target"},
	}
	for _, c := range cases {
		_, err := ParseTarget(tUUID, c.out)
		if err == nil || CodeOf(err, "") != c.code {
			t.Errorf("%s: got %v want %s", c.name, err, c.code)
		}
	}
}

func TestValidateHost(t *testing.T) {
	ok := map[string]string{
		"203.0.113.7": "203.0.113.7", "10.0.0.5": "10.0.0.5", "100.64.1.2": "100.64.1.2", "2001:db8::1": "2001:db8::1", "[2001:db8::1]": "2001:db8::1",
		"Server.Example.COM": "server.example.com", "srv1.example.com.": "srv1.example.com",
	}
	for in, want := range ok {
		got, err := ValidateHost(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q %v want %q", in, got, err, want)
		}
	}
	for _, in := range []string{
		"", "-x", "--help", "localhost", "foo.localhost", "host.docker.internal", "127.0.0.1", "127.1", "0x7f.1", "2130706433", "::1", "0.0.0.0", "::",
		"169.254.169.254", "fe80::1", "224.0.0.1", "ff02::1", "fe80::1%eth0", "a b", "a;b", "a$b", "a|b", "user@host", "host:22", "http://x", "a/b", "x\ny",
		"::ffff:127.0.0.1", "metadata.google.internal",
	} {
		if got, err := ValidateHost(in); err == nil {
			t.Errorf("accepted %q as %q", in, got)
		}
	}
}

// ---- argv (golden) -------------------------------------------------------------------------------------------------------------

func TestSSHArgsGolden(t *testing.T) {
	a, err := SSHArgs(tImage, tName, "/data/coolify/ssh/keys", tTarget, tKnown, RemoteCommand(false))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"docker", "run", "--rm", "-i", "--name", tName, "--network", "container:coolify", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "64", "--memory", "128m", "--pull=never",
		"--tmpfs", "/state:rw,mode=0700,size=1m", "-e", "HOME=/state", "-e", "TUGRA_KNOWN_HOST=" + tKnown, "--cap-add", "DAC_READ_SEARCH",
		"--mount", "type=bind,src=/data/coolify/ssh/keys,dst=/keys,readonly",
		"--entrypoint", "sh", tImage, "-c", sshWrapper, "sh",
		"-F", "/dev/null", "-i", "/keys/ssh_key@key1abcdef12",
		"-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
		"-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
		"-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=/state/known_hosts", "-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "HostKeyAlias=" + tUUID,
		"-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "LogLevel=ERROR",
		"-T", "-p", "22", "--", "root@203.0.113.7", "sh", "-s", "--",
	}
	if joined(a) != joined(want) {
		t.Fatalf("argv changed:\n got %s\nwant %s", joined(a), joined(want))
	}
}

func TestSSHArgsNeverWeakenHostKeyCheckingOrMountWritableKeys(t *testing.T) {
	a, _ := SSHArgs(tImage, tName, "/data/coolify/ssh/keys", tTarget, tKnown, RemoteCommand(true, "--image", tImage))
	j := joined(a)
	for _, banned := range []string{"StrictHostKeyChecking=no", "accept-new", "tugra-coolify-ssh-known", "type=volume", "UserKnownHostsFile=/dev/null", "--privileged", "--net host", "--network host", "docker.sock", "-v ", "ForwardAgent=yes", "-A "} {
		if strings.Contains(j, banned) {
			t.Fatalf("argv has %q", banned)
		}
	}
	for i, x := range a {
		if x == "--mount" && strings.Contains(a[i+1], "dst=/keys") && !strings.HasSuffix(a[i+1], ",readonly") {
			t.Fatal("the key directory must be read-only")
		}
	}
	// the script travels on stdin: no token placeholder, no env of the secret kind on the command line
	if strings.Contains(j, "TOKEN") || strings.Contains(j, "tugra_en_") {
		t.Fatal("a token on the command line")
	}
	// sudo form
	if !strings.HasSuffix(j, "sudo -n sh -s -- --image "+tImage) {
		t.Fatalf("sudo form wrong: %s", j)
	}
}

func TestArgvRefusesUnsafeValues(t *testing.T) {
	bad := []Target{
		{UUID: "-oProxyCommand=x", Host: "203.0.113.7", Port: 22, User: "root", KeyUUID: "key1abcdef12"},
		{UUID: tUUID, Host: "-oProxyCommand=x", Port: 22, User: "root", KeyUUID: "key1abcdef12"},
		{UUID: tUUID, Host: "203.0.113.7", Port: 0, User: "root", KeyUUID: "key1abcdef12"},
		{UUID: tUUID, Host: "203.0.113.7", Port: 22, User: "-l", KeyUUID: "key1abcdef12"},
		{UUID: tUUID, Host: "203.0.113.7", Port: 22, User: "root", KeyUUID: "../../etc/shadow"},
		{UUID: tUUID, Host: "127.0.0.1", Port: 22, User: "root", KeyUUID: "key1abcdef12"},
	}
	for i, b := range bad {
		if _, err := SSHArgs(tImage, tName, "/data/coolify/ssh/keys", b, tKnown, RemoteCommand(false)); err == nil {
			t.Errorf("ssh accepted %d", i)
		}
		if _, err := ScanArgs(tImage, tName, b); err == nil {
			t.Errorf("scan accepted %d", i)
		}
	}
	if _, err := SSHArgs("-oevil", tName, "/data/coolify/ssh/keys", tTarget, tKnown, nil); err == nil {
		t.Error("image with a dash accepted")
	}
	if _, err := SSHArgs(tImage, "bad name", "/data/coolify/ssh/keys", tTarget, tKnown, nil); err == nil {
		t.Error("bad helper name accepted")
	}
	for _, d := range []string{"/data/coolify/ssh/../../etc", "relative/keys", "/data/coolify/ssh/keys,dst=/x", ""} {
		if _, err := SSHArgs(tImage, tName, d, tTarget, tKnown, nil); err == nil {
			t.Errorf("key dir %q accepted", d)
		}
	}
}

func TestScanAndKeyCheckAndResolveArgs(t *testing.T) {
	s, _ := ScanArgs(tImage, tName, tTarget)
	if !has(s, "ssh-keyscan") || has(s, "--mount") || has(s, "-i") {
		t.Fatalf("scan must carry no mount and no key: %s", joined(s))
	}
	k, _ := KeyCheckArgs(tImage, tName, "/data/coolify/ssh/keys", tTarget)
	if !has(k, "test") || !has(k, "-r") || has(k, "cat") {
		t.Fatalf("key check must only test readability: %s", joined(k))
	}
	r := ResolveArgs()
	if r[0] != "docker" || r[1] != "exec" || !has(r, "coolify-db") || !strings.Contains(joined(r), "default_transaction_read_only=on") {
		t.Fatalf("resolve must be a read-only psql in coolify-db: %s", joined(r))
	}
	if joined(InspectCoolifyArgs()) != "docker inspect --format {{json .Mounts}} coolify" {
		t.Fatal("inspect args changed")
	}
}

func TestKeyDirFromMounts(t *testing.T) {
	ok := `[{"Type":"bind","Source":"/data/coolify/ssh","Destination":"/var/www/html/storage/app/ssh","Mode":"rw"}]`
	if d, err := KeyDirFromMounts(ok); err != nil || d != "/data/coolify/ssh/keys" {
		t.Fatalf("%q %v", d, err)
	}
	for name, in := range map[string]string{
		"not mounted":    `[{"Type":"bind","Source":"/data/coolify/source","Destination":"/var/www/html/.env"}]`,
		"other path":     `[{"Type":"bind","Source":"/home/someone/ssh","Destination":"/var/www/html/storage/app/ssh"}]`,
		"traversal":      `[{"Type":"bind","Source":"/data/coolify/ssh/../../etc","Destination":"/var/www/html/storage/app/ssh"}]`,
		"a volume":       `[{"Type":"volume","Source":"/data/coolify/ssh","Destination":"/var/www/html/storage/app/ssh"}]`,
		"trailing slash": `[{"Type":"bind","Source":"/data/coolify/ssh/","Destination":"/var/www/html/storage/app/ssh"}]`,
		"junk":           `nope`,
		"comma":          `[{"Type":"bind","Source":"/data/coolify/ssh,x","Destination":"/var/www/html/storage/app/ssh"}]`,
	} {
		if d, err := KeyDirFromMounts(in); err == nil {
			t.Errorf("%s: accepted %q", name, d)
		} else if CodeOf(err, "") != "no_key_file" {
			t.Errorf("%s: code %s", name, CodeOf(err, ""))
		}
	}
}

// ---- host key ------------------------------------------------------------------------------------------------------------------

func scanLine(host string) (line, fp string) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	blob := append([]byte{0, 0, 0, 11}, []byte("ssh-ed25519")...)
	blob = append(blob, 0, 0, 0, 32)
	blob = append(blob, pub...)
	return host + " ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob), Fingerprint(blob)
}

func TestFingerprintMatchesSSHKeygenFormat(t *testing.T) {
	line, fp := scanLine("203.0.113.7")
	got := KeyFingerprintsFromLines("# 203.0.113.7:22 SSH-2.0-OpenSSH_9.6\n" + line + "\n")
	if len(got) != 1 || got[0] != fp || !strings.HasPrefix(fp, "SHA256:") || len(fp) != 50 || strings.Contains(fp, "=") {
		t.Fatalf("%v %s", got, fp)
	}
}

func TestCheckHostKey(t *testing.T) {
	line, fp := scanLine("203.0.113.7")
	other, otherFp := scanLine("203.0.113.7")

	// first sight: trust on first use, report the fingerprint
	if got, pinned, err := CheckHostKey(line, "", ""); err != nil || got != fp || pinned {
		t.Fatalf("tofu: %q %v %v", got, pinned, err)
	}
	// Coolify pinned the same key (as a fingerprint, and as a key line): fine, and reported as pinned
	for _, pin := range []string{fp, "203.0.113.7 " + strings.SplitN(line, " ", 2)[1], strings.SplitN(line, " ", 2)[1]} {
		if got, pinned, err := CheckHostKey(line, pin, ""); err != nil || got != fp || !pinned {
			t.Fatalf("pin %q: %q %v %v", pin, got, pinned, err)
		}
	}
	// Coolify pinned another key: refused before anything is sent
	if _, _, err := CheckHostKey(line, otherFp, ""); CodeOf(err, "") != "hostkey_mismatch" {
		t.Fatalf("pinned mismatch: %v", err)
	}
	// an unreadable pin is not ignored
	if _, _, err := CheckHostKey(line, "garbage garbage", ""); CodeOf(err, "") != "bad_target" {
		t.Fatalf("unreadable pin: %v", err)
	}
	// the key moved between probe and install
	if _, _, err := CheckHostKey(other, "", fp); CodeOf(err, "") != "hostkey_changed" {
		t.Fatalf("changed: %v", err)
	}
	if got, _, err := CheckHostKey(line, "", fp); err != nil || got != fp {
		t.Fatalf("same: %q %v", got, err)
	}
	// nothing offered
	if _, _, err := CheckHostKey("", "", ""); CodeOf(err, "") != "unreachable" {
		t.Fatalf("empty: %v", err)
	}
}

func TestPreferredFingerprintTakesEd25519(t *testing.T) {
	rsa := "h ssh-rsa " + base64.StdEncoding.EncodeToString([]byte("not really an rsa key blob"))
	line, fp := scanLine("h")
	if got := PreferredFingerprint(rsa + "\n" + line); got != fp {
		t.Fatalf("got %s want %s", got, fp)
	}
}

// ---- scripts -------------------------------------------------------------------------------------------------------------------

func TestEmbeddedScriptsAreValidShellAndSafe(t *testing.T) {
	sh, err := exec.LookPath("sh")
	for _, op := range []string{"probe", "uninstall"} {
		s, ok := ScriptFor(op)
		if !ok || s == "" {
			t.Fatalf("no script for %s", op)
		}
		if err == nil {
			if out, e := exec.Command(sh, "-n", "-c", s).CombinedOutput(); e != nil {
				t.Fatalf("%s does not parse: %s", op, out)
			}
		}
		for _, banned := range []string{"rm -rf", "rm -fr", "mkfs", "dd if", "shutdown", "reboot", "curl | sh", "docker rm -f", "docker system", "docker volume prune", "docker image prune"} {
			if strings.Contains(s, banned) {
				t.Errorf("%s contains %q", op, banned)
			}
		}
		// the last line runs the function with stdin closed so no command inside can read the rest of the script off the ssh stream
		lines := strings.Split(strings.TrimSpace(s), "\n")
		if !strings.HasSuffix(lines[len(lines)-1], "</dev/null") {
			t.Errorf("%s must end by running its function with </dev/null", op)
		}
	}
	if ScriptSha256("install") != "" {
		t.Fatal("install has no embedded script")
	}
	if len(ScriptSha256("probe")) != 64 || ScriptSha256("probe") == ScriptSha256("uninstall") {
		t.Fatal("pins")
	}
}

func TestProbeScriptOnlyPrintsMarkedFactsAndNeverEnvValues(t *testing.T) {
	s, _ := ScriptFor("probe")
	// every printed line goes through p(), which prefixes TUGRA_PROBE
	if strings.Contains(s, "echo ") {
		t.Error("probe must print through p() only")
	}
	if strings.Contains(s, "TUGRA_TOKEN") || strings.Contains(s, "{{.Config.Env}}") {
		t.Error("probe must not print environment values")
	}
	// the env listing is only ever piped into grep -q
	for _, l := range strings.Split(s, "\n") {
		if strings.Contains(l, "Config.Env") && !strings.Contains(l, "grep -Fxq") {
			t.Errorf("env listing not confined to grep -q: %s", l)
		}
	}
	for _, mutating := range []string{"docker run", "docker rm", "docker stop", "docker pull", "mkdir", "chmod", "systemctl", "apt", "yum"} {
		if strings.Contains(s, mutating) {
			t.Errorf("a probe must be read-only: %q", mutating)
		}
	}
}

func TestUninstallScriptOnlyTouchesTheContainerItWasPinnedTo(t *testing.T) {
	s, _ := ScriptFor("uninstall")
	if strings.Contains(s, "tugra-agent ") && strings.Contains(s, "docker rm tugra-agent") {
		t.Error("never remove by name")
	}
	if !strings.Contains(s, `docker rm "$cid"`) || !strings.Contains(s, `docker stop -t 20 "$cid"`) {
		t.Error("remove by the verified id")
	}
	// the id and hub checks come before any removal
	iID, iRm := strings.Index(s, `[ "$cur" = "$cid" ]`), strings.Index(s, "docker stop")
	iHub := strings.Index(s, "refused_hub")
	if iID < 0 || iHub < 0 || iRm < iID || iRm < iHub {
		t.Error("verification must precede removal")
	}
	// only one file is removed, by name
	if strings.Count(s, "rm -f ") != 1 || !strings.Contains(s, "rm -f /etc/tugra/host-facts.json") {
		t.Error("only host-facts.json may be removed")
	}
}

// ---- probe parsing and verdicts -------------------------------------------------------------------------------------------------

func probeOut(kv ...string) string {
	var b strings.Builder
	b.WriteString("Welcome to Ubuntu\nLast login: today\n")
	for i := 0; i+1 < len(kv); i += 2 {
		b.WriteString("TUGRA_PROBE " + kv[i] + "=" + kv[i+1] + "\n")
	}
	return b.String()
}

var healthy = []string{"uid", "0", "arch", "x86_64", "docker_present", "yes", "docker_access", "yes", "sudo", "no", "sudo_docker", "no", "agent", "none", "disk_mb", "20480", "hub", "yes", "end", "1"}

func TestParseProbeIgnoresBannerAndBoundsValues(t *testing.T) {
	r := ParseProbe(probeOut(append(healthy, "mid", strings.Repeat("a", 64))...) + "TUGRA_PROBE evil=" + strings.Repeat("x", 500) + "\nTUGRA_PROBE bad line\n")
	if !r.Complete || r.Values["uid"] != "0" || len(r.Values["evil"]) != 96 {
		t.Fatalf("%+v", r)
	}
	f := r.Facts()
	if f.UID == nil || *f.UID != 0 || f.DockerAccess == nil || !*f.DockerAccess || f.Agent != "none" || f.DiskFreeMb == nil || *f.DiskFreeMb != 20480 || f.MachineIDHash != strings.Repeat("a", 64) {
		t.Fatalf("%+v", f)
	}
}

func TestTruncatedProbeIsUnknownNotAbsent(t *testing.T) {
	trunc := probeOut("uid", "0", "arch", "x86_64", "docker_present", "yes", "docker_access", "yes")
	r := ParseProbe(trunc)
	if r.Complete {
		t.Fatal("no end marker means incomplete")
	}
	if ok, code := r.Verdict(); ok || code != "installer_failed" {
		t.Fatalf("a truncated probe must fail closed, got %v %s", ok, code)
	}
	if r.Facts().Agent != "" {
		t.Fatal("agent presence must stay unknown")
	}
}

func with(base []string, kv ...string) []string {
	m := map[string]string{}
	var order []string
	for i := 0; i+1 < len(base); i += 2 {
		m[base[i]] = base[i+1]
		order = append(order, base[i])
	}
	for i := 0; i+1 < len(kv); i += 2 {
		if _, ok := m[kv[i]]; !ok {
			order = append(order, kv[i])
		}
		m[kv[i]] = kv[i+1]
	}
	var out []string
	for _, k := range order {
		out = append(out, k, m[k])
	}
	return out
}

func TestVerdict(t *testing.T) {
	cases := []struct {
		name string
		kv   []string
		ok   bool
		code string
		sudo bool
	}{
		{"root with docker", healthy, true, "ok_installed", false},
		{"already ours", with(healthy, "agent", "ours"), true, "skipped_present", false},
		{"another hub", with(healthy, "agent", "foreign_hub"), true, "skipped_foreign", false},
		{"stopped agent of ours is replaceable", with(healthy, "agent", "stopped"), true, "ok_installed", false},
		{"docker group user", with(healthy, "uid", "1000"), true, "ok_installed", false},
		{"sudo user", with(healthy, "uid", "1000", "docker_access", "no", "sudo", "yes", "sudo_docker", "yes"), true, "ok_installed", true},
		{"sudo without docker", with(healthy, "uid", "1000", "docker_access", "no", "sudo", "yes", "sudo_docker", "no"), false, "docker_perm", true},
		{"no sudo no docker", with(healthy, "uid", "1000", "docker_access", "no", "sudo", "no"), false, "needs_root", true},
		{"sudo needs a tty", with(healthy, "uid", "1000", "docker_access", "no", "sudo", "tty"), false, "sudo_tty", true},
		{"no sudo installed", with(healthy, "uid", "1000", "docker_access", "no", "sudo", "none"), false, "needs_root", true},
		{"no docker", with(healthy, "docker_present", "no", "docker_access", "no"), false, "docker_missing", false},
		{"daemon down as root", with(healthy, "docker_access", "no"), false, "docker_perm", false},
		{"odd arch", with(healthy, "arch", "riscv64"), false, "arch_unsupported", false},
		{"hub unreachable", with(healthy, "hub", "no"), false, "hub_unreachable_from_target", false},
		{"hub unknown does not block", with(healthy, "hub", "unknown"), true, "ok_installed", false},
	}
	for _, c := range cases {
		r := ParseProbe(probeOut(c.kv...))
		ok, code := r.Verdict()
		if ok != c.ok || code != c.code || r.UseSudo() != c.sudo {
			t.Errorf("%s: got %v %s sudo=%v want %v %s sudo=%v", c.name, ok, code, r.UseSudo(), c.ok, c.code, c.sudo)
		}
	}
}

func TestClassifySSHFailure(t *testing.T) {
	cases := map[string]string{
		"root@203.0.113.7: Permission denied (publickey).":                                  "auth_failed",
		"@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@":                          "hostkey_changed",
		"Host key verification failed.":                                                     "hostkey_changed",
		"ssh: connect to host 203.0.113.7 port 22: Connection timed out":                    "unreachable",
		"ssh: connect to host 203.0.113.7 port 22: Connection refused":                      "unreachable",
		"ssh: Could not resolve hostname x: Name or service not known":                      "unreachable",
		"sudo: a password is required":                                                      "needs_root",
		"sudo: sorry, you must have a tty to run sudo":                                      "sudo_tty",
		"docker: Got permission denied while trying to connect to the Docker daemon socket": "docker_perm",
		"sh: 1: docker: not found":                                                          "docker_missing",
		"error: could not pull ghcr.io/x":                                                   "pull_failed",
		"Warning: Identity file /keys/ssh_key@x not accessible: No such file or directory.": "no_key_file",
	}
	for in, want := range cases {
		if got := ClassifySSHFailure(in, 255, false); got != want {
			t.Errorf("%q: got %s want %s", in, got, want)
		}
	}
	if ClassifySSHFailure("", 255, false) != "unreachable" || ClassifySSHFailure("weird", 1, false) != "installer_failed" || ClassifySSHFailure("", 0, true) != "timeout" {
		t.Error("fallbacks")
	}
}

// ---- the runner, with a fake docker --------------------------------------------------------------------------------------------

type call struct {
	argv  []string
	stdin string
}

type fakeDocker struct {
	calls    []call
	row      string
	mounts   string
	keyOK    bool
	scan     string
	sshOut   Output
	scanFail bool
}

func newFake(scan string) *fakeDocker {
	return &fakeDocker{
		row:    row("3", "203.0.113.7", "22", "root", "key1abcdef12", "", "false", "false"),
		mounts: `[{"Type":"bind","Source":"/data/coolify/ssh","Destination":"/var/www/html/storage/app/ssh"}]`,
		keyOK:  true,
		scan:   scan,
		sshOut: Output{Stdout: []byte(probeOut(healthy...))},
	}
}

func (f *fakeDocker) exec(_ context.Context, argv []string, stdin []byte, _ string) (Output, error) {
	f.calls = append(f.calls, call{argv: argv, stdin: string(stdin)})
	switch {
	case has(argv, "coolify-db"):
		return Output{Stdout: []byte(f.row)}, nil
	case len(argv) > 1 && argv[1] == "inspect":
		return Output{Stdout: []byte(f.mounts)}, nil
	case has(argv, "test"):
		if f.keyOK {
			return Output{}, nil
		}
		return Output{ExitCode: 1}, nil
	case has(argv, "ssh-keyscan"):
		if f.scanFail {
			return Output{ExitCode: 1}, nil
		}
		return Output{Stdout: []byte(f.scan)}, nil
	case has(argv, "--entrypoint") && has(argv, "sh"):
		return f.sshOut, nil
	}
	return Output{ExitCode: 127}, nil
}

func (f *fakeDocker) runner() *Runner {
	return &Runner{Env: Env{Image: tImage, HubURL: "wss://hub.example.com/agent", HubPin: ""}, Exec: f.exec, NewID: func() string { return "0123456789ab" }}
}

func (f *fakeDocker) sshCall() *call {
	for i := range f.calls {
		if has(f.calls[i].argv, "sh") && has(f.calls[i].argv, "--entrypoint") {
			return &f.calls[i]
		}
	}
	return nil
}

const installBody = "tugra_install_main() {\necho hi\n}\ntugra_install_main \"$@\" </dev/null\necho TUGRA_INSTALL_OK\n"

func TestRunProbeReportsFactsAndTheFingerprintTheAgentSaw(t *testing.T) {
	line, fp := scanLine("203.0.113.7")
	f := newFake(line)
	res := f.runner().Run(context.Background(), "r1", Request{Op: "probe", UUID: tUUID})
	if !res.OK || res.Code != "ok_installed" || res.Probe == nil || res.Probe.SSHHostKeyFp != fp || res.Probe.HostKeyPinned == nil || *res.Probe.HostKeyPinned {
		t.Fatalf("%+v %+v", res, res.Probe)
	}
	c := f.sshCall()
	if c == nil || !strings.Contains(c.stdin, "tugra_probe_main") || !strings.Contains(c.stdin, "export TUGRA_HUB='wss://hub.example.com/agent'") {
		t.Fatal("the probe script must go on stdin with the agent's own hub")
	}
}

func TestRunStopsBeforeSendingAnythingWhenTheHostKeyDiffers(t *testing.T) {
	line, _ := scanLine("203.0.113.7")
	_, other := scanLine("203.0.113.7")
	f := newFake(line)
	res := f.runner().Run(context.Background(), "r1", Request{Op: "install", UUID: tUUID, Script: installBody, Payload: tToken, ExpectedFp: other})
	if res.OK || res.Code != "hostkey_changed" || f.sshCall() != nil {
		t.Fatalf("%+v", res)
	}
	// Coolify pinned another key
	f2 := newFake(line)
	f2.row = row("3", "203.0.113.7", "22", "root", "key1abcdef12", other, "false", "false")
	res = f2.runner().Run(context.Background(), "r2", Request{Op: "probe", UUID: tUUID})
	if res.OK || res.Code != "hostkey_mismatch" || f2.sshCall() != nil {
		t.Fatalf("%+v", res)
	}
}

func TestRunInstallSendsTheTokenOnStdinOnly(t *testing.T) {
	line, fp := scanLine("203.0.113.7")
	f := newFake(line)
	f.sshOut = Output{Stdout: []byte("TUGRA_INSTALL_CID " + tCID + "\nTUGRA_INSTALL_OK\n")}
	r := f.runner()
	r.Env.HubPin = "sha256:" + strings.Repeat("ab", 32)
	res := r.Run(context.Background(), "r1", Request{Op: "install", UUID: tUUID, Script: installBody, Payload: tToken, ExpectedFp: fp, UseSudo: true})
	if !res.OK || res.Code != "ok_installed" || res.ContainerID != tCID {
		t.Fatalf("%+v", res)
	}
	for _, c := range f.calls {
		if strings.Contains(joined(c.argv), tToken) || strings.Contains(joined(c.argv), "tugra_en_") {
			t.Fatalf("token on an argv: %s", joined(c.argv))
		}
	}
	c := f.sshCall()
	if !strings.Contains(c.stdin, "export TUGRA_TOKEN='"+tToken+"'") || !strings.Contains(c.stdin, "export TUGRA_SKIP_DOCKER_INSTALL='1'") || !strings.Contains(c.stdin, "export TUGRA_HUB_PIN='sha256:") {
		t.Fatalf("prefix wrong: %q", c.stdin)
	}
	if !strings.HasSuffix(joined(c.argv), "sudo -n sh -s -- --image "+tImage) {
		t.Fatalf("remote command: %s", joined(c.argv))
	}
}

func TestRunInstallRefusesBadInputsBeforeAnyDockerCall(t *testing.T) {
	line, _ := scanLine("203.0.113.7")
	for name, rq := range map[string]Request{
		"bad token":        {Op: "install", UUID: tUUID, Script: installBody, Payload: "tugra_en_x; rm -rf /"},
		"token in script":  {Op: "install", UUID: tUUID, Script: installBody + tToken, Payload: tToken},
		"no success line":  {Op: "install", UUID: tUUID, Script: "echo hi", Payload: tToken},
		"empty script":     {Op: "install", UUID: tUUID, Script: "", Payload: tToken},
		"bad container id": {Op: "uninstall", UUID: tUUID, Payload: "tugra-agent"},
	} {
		f := newFake(line)
		res := f.runner().Run(context.Background(), "r", rq)
		if res.OK || f.sshCall() != nil {
			t.Errorf("%s: %+v", name, res)
		}
	}
}

func TestRunRefusesCoolifysOwnServerAndAMissingKey(t *testing.T) {
	line, _ := scanLine("203.0.113.7")
	f := newFake(line)
	f.row = row("0", "host.docker.internal", "22", "root", "key1abcdef12", "", "false", "false")
	if res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID}); res.OK || res.Code != "bad_target" || f.sshCall() != nil {
		t.Fatalf("%+v", res)
	}
	f = newFake(line)
	f.keyOK = false
	if res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID}); res.OK || res.Code != "no_key_file" || f.sshCall() != nil {
		t.Fatalf("%+v", res)
	}
	f = newFake(line)
	f.row = ""
	if res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: "abc123def456"}); res.OK || res.Code != "bad_target" {
		t.Fatalf("a server Coolify does not have must be refused: %+v", res)
	}
	f = newFake(line)
	f.scanFail = true
	if res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID}); res.OK || res.Code != "unreachable" {
		t.Fatalf("%+v", res)
	}
}

func TestRunUninstallIsPinnedToTheContainerId(t *testing.T) {
	line, _ := scanLine("203.0.113.7")
	f := newFake(line)
	f.sshOut = Output{Stdout: []byte("TUGRA_UNINSTALL ok\n")}
	res := f.runner().Run(context.Background(), "r", Request{Op: "uninstall", UUID: tUUID, Payload: tCID})
	if !res.OK {
		t.Fatalf("%+v", res)
	}
	c := f.sshCall()
	if !strings.Contains(c.stdin, "export TUGRA_CID='"+tCID+"'") || !strings.Contains(c.stdin, "tugra_uninstall_main") {
		t.Fatal("uninstall prefix")
	}
	f.sshOut = Output{Stdout: []byte("TUGRA_UNINSTALL refused_id\n")}
	if res := f.runner().Run(context.Background(), "r", Request{Op: "uninstall", UUID: tUUID, Payload: tCID}); res.OK || res.Code != "bad_target" {
		t.Fatalf("a refusal on the target is a failure: %+v", res)
	}
}

func TestRunMapsSSHFailures(t *testing.T) {
	line, _ := scanLine("203.0.113.7")
	f := newFake(line)
	f.sshOut = Output{Stderr: []byte("root@203.0.113.7: Permission denied (publickey)."), ExitCode: 255}
	if res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID}); res.OK || res.Code != "auth_failed" {
		t.Fatalf("%+v", res)
	}
	f.sshOut = Output{TimedOut: true}
	if res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID}); res.OK || res.Code != "timeout" {
		t.Fatalf("%+v", res)
	}
	f.sshOut = Output{Stdout: []byte("some banner\n")}
	if res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID}); res.OK || res.Code != "installer_failed" {
		t.Fatalf("a silent probe is a failure, not an empty server: %+v", res)
	}
	f.sshOut = Output{Stdout: []byte("pulling\n"), Stderr: []byte("error: could not pull ghcr.io/x"), ExitCode: 1}
	if res := f.runner().Run(context.Background(), "r", Request{Op: "install", UUID: tUUID, Script: installBody, Payload: tToken}); res.OK || res.Code != "pull_failed" {
		t.Fatalf("%+v", res)
	}
}

func TestRunOnACancelledContext(t *testing.T) {
	line, _ := scanLine("203.0.113.7")
	f := newFake(line)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res := f.runner().Run(ctx, "r", Request{Op: "probe", UUID: tUUID})
	if res.OK || res.Code != "cancelled" || len(f.calls) != 0 {
		t.Fatalf("%+v calls=%d", res, len(f.calls))
	}
}

func TestResultCarriesNoTargetOutput(t *testing.T) {
	line, _ := scanLine("203.0.113.7")
	f := newFake(line)
	f.sshOut = Output{Stdout: []byte(probeOut(append(healthy, "evil", "SECRET-LOOKING-VALUE")...)), Stderr: []byte("SECRET-STDERR")}
	res := f.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID})
	b := joined([]string{res.Code, res.Probe.Arch, res.Probe.Agent, res.Probe.SSHHostKeyFp, res.Probe.MachineIDHash, res.Probe.DockerEngineID})
	if strings.Contains(b, "SECRET") {
		t.Fatal("target output leaked into the result")
	}
}

func TestExecDockerRefusesAnythingButDocker(t *testing.T) {
	if _, err := ExecDocker(context.Background(), []string{"sh", "-c", "id"}, nil, ""); err == nil {
		t.Fatal("must only run docker")
	}
	if _, err := ExecDocker(context.Background(), nil, nil, ""); err == nil {
		t.Fatal("empty argv")
	}
}

func TestScrub(t *testing.T) {
	got := scrub("failed with "+tToken+" inside", tToken)
	if strings.Contains(got, tToken) {
		t.Fatal(got)
	}
}

// ---- finding: the ssh connection itself is pinned to the verified key ---------------------------------------------------------

func TestKnownHostLinePinsTheVerifiedKeyOnly(t *testing.T) {
	l1, fp1 := scanLine("203.0.113.7")
	l2, fp2 := scanLine("203.0.113.7")
	scan := "# 203.0.113.7:22 SSH-2.0-OpenSSH_9.6\n" + l1 + "\n" + l2 + "\n"
	got, err := KnownHostLine(scan, fp2, tUUID)
	if err != nil || !strings.HasPrefix(got, tUUID+" ssh-ed25519 ") || strings.Contains(got, strings.Fields(l1)[2]) {
		t.Fatalf("only the verified key may be trusted: %q %v", got, err)
	}
	if fs := KeyFingerprintsFromLines(got); len(fs) != 1 || fs[0] != fp2 {
		t.Fatalf("fingerprint of the line: %v", fs)
	}
	if got, _ := KnownHostLine(scan, fp1, tUUID); !strings.Contains(got, strings.Fields(l1)[2]) {
		t.Fatal("first key")
	}
	_, otherFp := scanLine("x")
	if _, err := KnownHostLine(scan, otherFp, tUUID); CodeOf(err, "") != "hostkey_changed" {
		t.Fatalf("a fingerprint not in the scan must be refused: %v", err)
	}
	if _, err := KnownHostLine("", fp1, tUUID); err == nil {
		t.Fatal("empty scan")
	}
	// a host field that tries to smuggle a second line or option is never copied: the alias comes from the validated target
	evil := "x\nevil " + strings.Join(strings.Fields(l1)[1:], " ")
	if got, err := KnownHostLine(evil, fp1, tUUID); err != nil || strings.Contains(got, "evil") || strings.Contains(got, "\n") {
		t.Fatalf("%q %v", got, err)
	}
}

func TestSSHArgsRefuseWithoutAVerifiedKey(t *testing.T) {
	for name, kh := range map[string]string{
		"empty":       "",
		"other alias": "zzzzzz111111 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"newline":     tKnown + "\n" + tKnown,
		"bad type":    tUUID + " ssh-dss AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"option":      tUUID + " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAA -oProxyCommand=x",
	} {
		if _, err := SSHArgs(tImage, tName, "/data/coolify/ssh/keys", tTarget, kh, RemoteCommand(false)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestCheckHostKeyBindsPinAndExpectationToTheSameKey(t *testing.T) {
	l1, fp1 := scanLine("203.0.113.7")
	l2, fp2 := scanLine("203.0.113.7")
	scan := l1 + "\n" + l2
	// Coolify pinned key 1, the hub expects key 2: both are on the wire but they are not one key
	if _, _, err := CheckHostKey(scan, fp1, fp2); CodeOf(err, "") != "hostkey_mismatch" {
		t.Fatalf("pin and expectation must be the same key: %v", err)
	}
	if got, _, err := CheckHostKey(scan, fp1, fp1); err != nil || got != fp1 {
		t.Fatalf("%q %v", got, err)
	}
}

func TestRunPinsTheSSHConnectionToTheScannedVerifiedKey(t *testing.T) {
	line, fp := scanLine("203.0.113.7")
	f := newFake(line)
	f.sshOut = Output{Stdout: []byte("TUGRA_INSTALL_CID " + tCID + "\nTUGRA_INSTALL_OK\n")}
	res := f.runner().Run(context.Background(), "r", Request{Op: "install", UUID: tUUID, Script: installBody, Payload: tToken, ExpectedFp: fp})
	if !res.OK {
		t.Fatalf("%+v", res)
	}
	j := joined(f.sshCall().argv)
	want := tUUID + " " + strings.Join(strings.Fields(line)[1:], " ")
	if !strings.Contains(j, "TUGRA_KNOWN_HOST="+want) || !strings.Contains(j, "StrictHostKeyChecking=yes") || strings.Contains(j, "accept-new") {
		t.Fatalf("ssh must be pinned to the verified key: %s", j)
	}
	f2 := newFake(line)
	if r := f2.runner().Run(context.Background(), "r", Request{Op: "probe", UUID: tUUID}); !r.OK {
		t.Fatalf("%+v", r)
	}
	if !strings.Contains(joined(f2.sshCall().argv), "TUGRA_KNOWN_HOST="+want) {
		t.Fatal("probe not pinned")
	}
}
