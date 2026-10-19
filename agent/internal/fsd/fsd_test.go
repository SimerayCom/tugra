package fsd

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestValidatePathRejectsEscapes(t *testing.T) {
	bad := []string{
		"../etc/passwd",
		"a/../../x",
		"/etc/passwd",      // absolute
		"a\\b",             // backslash
		"a/..",             // trailing ..
		"..",               // bare ..
		string([]byte{'a', 0, 'b'}), // NUL
	}
	for _, p := range bad {
		if err := validatePath(p); err == nil {
			t.Errorf("validatePath(%q) = nil, want error", p)
		}
	}
	// A path longer than the cap is rejected.
	long := make([]byte, maxPathLen+1)
	for i := range long {
		long[i] = 'a'
	}
	if err := validatePath(string(long)); err == nil {
		t.Error("validatePath(very long) = nil, want error")
	}
}

func TestValidatePathAllowsSafe(t *testing.T) {
	for _, p := range []string{"", ".", "a", "a/b/c", "a.b", "dir/file.txt", "a..b"} {
		if err := validatePath(p); err != nil {
			t.Errorf("validatePath(%q) = %v, want nil", p, err)
		}
	}
}

func TestValidateVolume(t *testing.T) {
	// Anything that could turn `--mount src=<volume>` into a host bind or smuggle mount fields is rejected.
	for _, bad := range []string{
		"", "/", "/etc", "/var/run", ".", "..", "./x", "-x",
		"a:b", "a/b", "a,dst=/x", "a=b", "a b", "a\\b",
		strings.Repeat("a", 129), // over the 128-char cap
	} {
		if err := validateVolume(bad); err == nil {
			t.Errorf("validateVolume(%q) = nil, want error", bad)
		}
	}
	for _, ok := range []string{"tugra_appv_x_data", "a", "A0", "v-1.2_3", strings.Repeat("a", 128)} {
		if err := validateVolume(ok); err != nil {
			t.Errorf("validateVolume(%q) = %v, want nil", ok, err)
		}
	}
}

func TestListClassifiesEntriesAndDoesNotFollowSymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A symlink pointing OUTSIDE the root must be reported as a symlink, never followed/dereferenced.
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "escape")); err != nil {
		t.Skip("symlinks unavailable on this platform")
	}

	entries, truncated, err := List(dir, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if truncated {
		t.Error("truncated = true for a 3-entry dir")
	}
	byName := map[string]string{}
	for _, e := range entries {
		byName[e.Name] = e.Type
	}
	if byName["f.txt"] != "file" {
		t.Errorf("f.txt type = %q, want file", byName["f.txt"])
	}
	if byName["sub"] != "dir" {
		t.Errorf("sub type = %q, want dir", byName["sub"])
	}
	if byName["escape"] != "symlink" {
		t.Errorf("escape type = %q, want symlink (not followed)", byName["escape"])
	}
}

func TestListRejectsTraversal(t *testing.T) {
	if _, _, err := List(t.TempDir(), "../.."); err == nil {
		t.Error("List with '../..' = nil, want error")
	}
}

func TestListRejectsNonDirTargets(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A regular file is not a directory: refused (no open), not listed.
	if _, _, err := List(dir, "f.txt"); err == nil {
		t.Error("List of a regular file = nil, want error")
	}
	// A FIFO must be refused by the Lstat type-check BEFORE any open — otherwise open(2) blocks forever.
	fifo := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skipf("mkfifo unavailable: %v", err)
	}
	done := make(chan error, 1)
	go func() { _, _, err := List(dir, "pipe"); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Error("List of a FIFO = nil, want 'not a directory' error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("List of a FIFO blocked — Lstat type-check is missing (open hung on the pipe)")
	}
}

func TestListTruncatesHugeDir(t *testing.T) {
	dir := t.TempDir()
	// maxEntries+100 files: the listing must cap and flag truncated.
	for i := 0; i < maxEntries+100; i++ {
		if err := os.WriteFile(filepath.Join(dir, "f"+strconv.Itoa(i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	entries, truncated, err := List(dir, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !truncated {
		t.Error("truncated = false for an over-cap dir")
	}
	if len(entries) != maxEntries {
		t.Errorf("len(entries) = %d, want %d (capped)", len(entries), maxEntries)
	}
}

func TestBuildHelperArgsHasAllHardeningFlags(t *testing.T) {
	args, err := BuildHelperArgs("ghcr.io/simeraycom/tugra-agent@sha256:abc", "tugra_appv_x_data", "list", "sub/dir")
	if err != nil {
		t.Fatalf("BuildHelperArgs: %v", err)
	}
	for _, want := range [][]string{
		{"--network", "none"},
		{"--read-only"},
		{"--cap-drop", "ALL"},
		{"--security-opt", "no-new-privileges"},
	} {
		if !containsSeq(args, want) {
			t.Errorf("args missing %v; got %v", want, args)
		}
	}
	// The volume MUST be mounted as a NAMED VOLUME, read-only — never a `-v src:/data` spec that could
	// fall back to a host bind mount.
	if !slices.Contains(args, "type=volume,src=tugra_appv_x_data,dst=/data,readonly,volume-nocopy") {
		t.Errorf("args missing named-volume read-only --mount; got %v", args)
	}
	if slices.Contains(args, "-v") {
		t.Errorf("args used -v (bind-capable) instead of --mount; got %v", args)
	}
	// No shell — the op/path are plain argv after the `fsd` subcommand.
	if args[len(args)-3] != "fsd" || args[len(args)-2] != "list" || args[len(args)-1] != "sub/dir" {
		t.Errorf("args tail = %v, want [... fsd list sub/dir]", args[len(args)-3:])
	}
}

func TestBuildHelperArgsRejectsUnsafeInput(t *testing.T) {
	img := "ghcr.io/simeraycom/tugra-agent@sha256:abc"
	cases := []struct{ name, image, volume, op string }{
		{"host-root volume", img, "/", "list"},
		{"host-path volume", img, "/etc", "list"},
		{"mount-field injection", img, "v,dst=/host", "list"},
		{"colon injection", img, "v:/host:rw", "list"},
		{"unknown op", img, "tugra_appv_x_data", "write"},
		{"flag-like image", "-v/host:/host", "tugra_appv_x_data", "list"},
		{"empty image", "", "tugra_appv_x_data", "list"},
	}
	for _, c := range cases {
		if _, err := BuildHelperArgs(c.image, c.volume, c.op, "p"); err == nil {
			t.Errorf("%s: BuildHelperArgs = nil error, want rejection", c.name)
		}
	}
}

func containsSeq(hay, seq []string) bool {
	for i := 0; i+len(seq) <= len(hay); i++ {
		if slices.Equal(hay[i:i+len(seq)], seq) {
			return true
		}
	}
	return false
}
