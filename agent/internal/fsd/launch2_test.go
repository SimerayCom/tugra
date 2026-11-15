package fsd

import (
	"strings"
	"testing"
)

const sha64 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

func TestBuildHelperArgs2Profiles(t *testing.T) {
	// Read class == the legacy list profile (modulo the fsd2 subcommand tail).
	legacy, err := BuildHelperArgs("img:1", "vol_a", "list", "p", "tugra-fsd-aa")
	if err != nil {
		t.Fatal(err)
	}
	got, stdin, err := BuildHelperArgs2("img:1", "vol_a", Req2{Op: "stat", Path: "p"}, "tugra-fsd-aa")
	if err != nil || stdin {
		t.Fatalf("stat: %v stdin=%v", err, stdin)
	}
	idx := indexOf(legacy, "img:1")
	if strings.Join(got[:idx+1], " ") != strings.Join(legacy[:idx+1], " ") {
		t.Fatalf("read profile diverged from the legacy list profile:\n got %v\nlegacy %v", got[:idx+1], legacy[:idx+1])
	}
	wantRead := "docker run --rm --name tugra-fsd-aa --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges --pids-limit 64 --memory 128m --mount type=volume,src=vol_a,dst=/data,readonly,volume-nocopy --entrypoint tugra-agent img:1 fsd2 stat --path=p"
	if strings.Join(got, " ") != wantRead {
		t.Fatalf("read argv:\n got %s\nwant %s", strings.Join(got, " "), wantRead)
	}

	w, stdin, err := BuildHelperArgs2("img:1", "vol_a", Req2{Op: "write", Path: "d/f.txt", Mode: "0644", Flags: "o", Size: 5, Sha256: sha64, IfMatch: "5-9"}, "tugra-fsd-aa")
	if err != nil || !stdin {
		t.Fatalf("write: %v stdin=%v", err, stdin)
	}
	wantWrite := "docker run --rm -i --name tugra-fsd-aa --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges --pids-limit 64 --memory 128m --mount type=volume,src=vol_a,dst=/data,volume-nocopy --entrypoint tugra-agent img:1 fsd2 write --path=d/f.txt --mode=0644 --size=5 --sha256=" + sha64 + " --flags=o --if-match=5-9"
	if strings.Join(w, " ") != wantWrite {
		t.Fatalf("write argv:\n got %s\nwant %s", strings.Join(w, " "), wantWrite)
	}
}

func indexOf(a []string, s string) int {
	for i, v := range a {
		if v == s {
			return i
		}
	}
	return -1
}

func TestBuildHelperArgs2NoForbiddenFlags(t *testing.T) {
	forbidden := []string{"FSETID", "MKNOD", "SETUID", "SETGID", "SYS_ADMIN", "--privileged", "-v", "--volume", "--volumes-from", "docker.sock", "--env", "-e", "--network=host", "--pid", "--cap-add=ALL", "--userns", "--ipc", "--uts", "--security-opt=seccomp=unconfined"}
	reqs := []Req2{
		{Op: "stat", Path: ""}, {Op: "read", Path: "a", Size: 1},
		{Op: "write", Path: "a", Size: 1}, {Op: "mkdir", Path: "a", Flags: "p"},
		{Op: "rename", Path: "a", Path2: "b"}, {Op: "chmod", Path: "a", Mode: "600"}, {Op: "delete", Path: "a", Flags: "r"},
	}
	for _, r := range reqs {
		a, _, err := BuildHelperArgs2("img", "vol", r, "n1")
		if err != nil {
			t.Fatalf("%s: %v", r.Op, err)
		}
		// Only inspect the docker-side argv (before the image), where flags live.
		for _, f := range forbidden {
			for _, tok := range a[:indexOf(a, "img")] {
				if tok == f || strings.HasPrefix(tok, f+"=") || (strings.HasPrefix(f, "--") == false && strings.Contains(tok, f) && len(f) > 3) {
					t.Errorf("%s: forbidden %q in argv %v", r.Op, f, a)
				}
			}
		}
		mount := a[indexOf(a, "--mount")+1]
		if !strings.HasPrefix(mount, "type=volume,src=vol,dst=/data,") {
			t.Errorf("%s: mount %q", r.Op, mount)
		}
		ro := strings.Contains(mount, ",readonly")
		if ro != (r.Op == "stat" || r.Op == "read") {
			t.Errorf("%s: readonly=%v wrong for its class", r.Op, ro)
		}
		// exactly one --cap-drop ALL and no DAC_READ_SEARCH on the mutating profile
		if (indexOf(a, "DAC_READ_SEARCH") >= 0) != ro {
			t.Errorf("%s: DAC_READ_SEARCH presence wrong", r.Op)
		}
	}
}

func TestBuildHelperArgs2Rejects(t *testing.T) {
	good := Req2{Op: "write", Path: "a", Size: 1, Sha256: sha64}
	cases := map[string]func() (string, string, Req2, string){
		"vol slash":   func() (string, string, Req2, string) { return "img", "/", good, "n" },
		"vol host":    func() (string, string, Req2, string) { return "img", "/etc", good, "n" },
		"vol colon":   func() (string, string, Req2, string) { return "img", "v:/x", good, "n" },
		"vol comma":   func() (string, string, Req2, string) { return "img", "v,dst=/etc", good, "n" },
		"vol equals":  func() (string, string, Req2, string) { return "img", "v=x", good, "n" },
		"vol empty":   func() (string, string, Req2, string) { return "img", "", good, "n" },
		"image dash":  func() (string, string, Req2, string) { return "--privileged", "v", good, "n" },
		"image empty": func() (string, string, Req2, string) { return "", "v", good, "n" },
		"name bad":    func() (string, string, Req2, string) { return "img", "v", good, "-x" },
		"op unknown":  func() (string, string, Req2, string) { return "img", "v", Req2{Op: "list", Path: "a"}, "n" },
		"op exec":     func() (string, string, Req2, string) { return "img", "v", Req2{Op: "exec", Path: "a"}, "n" },
		"path ..":     func() (string, string, Req2, string) { return "img", "v", Req2{Op: "delete", Path: "../x"}, "n" },
		"path root":   func() (string, string, Req2, string) { return "img", "v", Req2{Op: "delete", Path: ""}, "n" },
		"path part":   func() (string, string, Req2, string) { return "img", "v", Req2{Op: "stat", Path: ".tugra-part-x"}, "n" },
		"path2 on op": func() (string, string, Req2, string) { return "img", "v", Req2{Op: "stat", Path: "a", Path2: "b"}, "n" },
		"rename p2":   func() (string, string, Req2, string) { return "img", "v", Req2{Op: "rename", Path: "a"}, "n" },
		"mode suid": func() (string, string, Req2, string) {
			return "img", "v", Req2{Op: "chmod", Path: "a", Mode: "4755"}, "n"
		},
		"chmod nomod": func() (string, string, Req2, string) { return "img", "v", Req2{Op: "chmod", Path: "a"}, "n" },
		"flags x": func() (string, string, Req2, string) {
			return "img", "v", Req2{Op: "delete", Path: "a", Flags: "x"}, "n"
		},
		"flags dup": func() (string, string, Req2, string) {
			return "img", "v", Req2{Op: "delete", Path: "a", Flags: "rr"}, "n"
		},
		"sha short": func() (string, string, Req2, string) {
			return "img", "v", Req2{Op: "write", Path: "a", Sha256: "abc"}, "n"
		},
		"ifmatch": func() (string, string, Req2, string) {
			return "img", "v", Req2{Op: "write", Path: "a", IfMatch: "x"}, "n"
		},
		"size neg": func() (string, string, Req2, string) { return "img", "v", Req2{Op: "write", Path: "a", Size: -1}, "n" },
	}
	for name, mk := range cases {
		img, vol, r, n := mk()
		if _, _, err := BuildHelperArgs2(img, vol, r, n); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestBuildHelperArgs2DashPathStaysInside(t *testing.T) {
	a, _, err := BuildHelperArgs2("img", "v", Req2{Op: "delete", Path: "-rf", Flags: "r"}, "n")
	if err != nil {
		t.Fatal(err)
	}
	if a[len(a)-2] != "--path=-rf" || a[len(a)-1] != "--flags=r" {
		t.Fatalf("argv tail = %v", a[len(a)-3:])
	}
}

// Legacy BuildHelperArgs must be byte-identical to before this feature.
func TestBuildHelperArgsLegacyUnchanged(t *testing.T) {
	got, err := BuildHelperArgs("img:1", "vol_a", "list", "sub", "tugra-fsd-aa")
	if err != nil {
		t.Fatal(err)
	}
	want := "docker run --rm --name tugra-fsd-aa --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges --pids-limit 64 --memory 128m --mount type=volume,src=vol_a,dst=/data,readonly,volume-nocopy --entrypoint tugra-agent img:1 fsd list sub"
	if strings.Join(got, " ") != want {
		t.Fatalf("legacy argv changed:\n got %s\nwant %s", strings.Join(got, " "), want)
	}
}
