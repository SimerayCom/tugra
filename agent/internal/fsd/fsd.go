// Package fsd is the Tugra agent's sandboxed file helper (CASA-FILES). It runs as the subcommand
// `tugra-agent fsd <op> <path>` INSIDE an ephemeral, network-less, read-only, capability-stripped container
// (see BuildHelperArgs) with ONLY the target app volume mounted read-only at /data. It never runs a shell and
// never follows a symlink out of the volume: os.Root (openat2) confines every path to /data, and the path is
// validated before any filesystem call. Output is JSON on stdout; errors go to stderr with a non-zero exit.
package fsd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// RootPath is where the app volume is mounted (read-only) in the helper container.
const RootPath = "/data"

// maxPathLen bounds a single request path well under PATH_MAX before any syscall.
const maxPathLen = 4096

// maxEntries caps a single listing. A volume dir can hold millions of entries (the app controls its
// own volume), which would OOM the 128m helper or blow past the hub's WS frame limit — so we read in
// batches and stop here, flagging the result truncated.
const maxEntries = 10000

// volumeRe is Docker's own named-volume charset. Validating against it BEFORE the value reaches a
// `docker ... --mount src=<volume>` argv guarantees the source is a NAMED VOLUME, never a host path:
// a '/'- or '.'-leading value, or one carrying ':' / ',' / '=', is rejected, so there is no way to turn
// the mount into a host bind or to smuggle extra mount fields.
var volumeRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// nameRe is Docker's container-name charset, used for the launcher's generated --name handle.
var nameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// validateVolume rejects any value that is not a plain Docker named volume (see volumeRe).
func validateVolume(v string) error {
	if !volumeRe.MatchString(v) {
		return errors.New("invalid volume name")
	}
	return nil
}

// validatePath rejects anything that could escape the volume or confuse the OS, BEFORE touching the
// filesystem. os.Root is the hard confinement; this is defense-in-depth + clear errors. A volume-relative
// path only: no NUL, no backslash, no absolute path, no ".." segment, bounded length. "" / "." mean the root.
func validatePath(p string) error {
	if len(p) > maxPathLen {
		return errors.New("path too long")
	}
	if strings.ContainsRune(p, 0) {
		return errors.New("path contains a NUL byte")
	}
	if strings.ContainsRune(p, '\\') {
		return errors.New("backslash is not allowed in a path")
	}
	if strings.HasPrefix(p, "/") {
		return errors.New("absolute paths are not allowed")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return errors.New("'..' path segments are not allowed")
		}
	}
	return nil
}

// kind classifies a dir entry WITHOUT dereferencing it — a symlink is reported as "symlink".
func kind(m fs.FileMode) string {
	switch {
	case m&fs.ModeSymlink != 0:
		return "symlink"
	case m.IsDir():
		return "dir"
	case m.IsRegular():
		return "file"
	default:
		return "other" // device / socket / fifo — reported, never opened
	}
}

// List returns the entries of a directory within rootPath. Symlinks are reported, never followed; os.Root
// refuses any entry (or a symlinked directory) that would resolve outside rootPath. The second return is
// true when the listing was capped at maxEntries. The target MUST be a real directory: we Lstat it first
// and refuse a symlink, FIFO, device or socket, so opening it can never block (a FIFO open(2) would hang
// forever) and we never follow a symlinked target out of the no-follow policy.
func List(rootPath, rel string) ([]protocol.FsEntry, bool, error) {
	if err := validatePath(rel); err != nil {
		return nil, false, err
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, false, err
	}
	defer root.Close()
	name := rel
	if name == "" {
		name = "."
	}
	// Type-check with Lstat (no symlink follow, never blocks) BEFORE opening. Only a real directory is
	// opened — this is what keeps a FIFO/device/socket from hanging or being opened at all.
	info, err := root.Lstat(name)
	if err != nil {
		return nil, false, err
	}
	if !info.IsDir() {
		return nil, false, errors.New("not a directory")
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	out := make([]protocol.FsEntry, 0, 256)
	truncated := false
	for {
		// Read in bounded batches so a directory with millions of entries can never buffer unboundedly.
		des, rerr := f.ReadDir(512)
		for _, de := range des {
			if len(out) >= maxEntries {
				truncated = true
				break
			}
			e := protocol.FsEntry{Name: de.Name(), Type: kind(de.Type())}
			if di, ierr := de.Info(); ierr == nil { // Info() reports the entry itself, not a symlink's target
				e.Size = di.Size()
				e.Mode = di.Mode().Perm().String()
				e.Mtime = di.ModTime().Unix()
			}
			out = append(out, e)
		}
		if truncated {
			break
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, false, rerr
		}
	}
	return out, truncated, nil
}

// RunCLI is the `tugra-agent fsd <op> <path>` entrypoint (invoked inside the helper container). It prints a
// JSON result on stdout and returns a process exit code (0 ok, non-zero on error with a stderr message).
func RunCLI(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "fsd: missing op")
		return 2
	}
	op := args[0]
	rel := ""
	if len(args) > 1 {
		rel = args[1]
	}
	switch op {
	case "list":
		entries, truncated, err := List(RootPath, rel)
		if err != nil {
			fmt.Fprintln(os.Stderr, "fsd:", err)
			return 1
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"entries": entries, "truncated": truncated})
		return 0
	default:
		fmt.Fprintln(os.Stderr, "fsd: unsupported op:", op)
		return 2
	}
}
