package scan

import (
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// rootFS reads files "as the host sees them" from a mount of the host root. A symlink on the host that points at an
// absolute path (/etc/nginx/sites-available/x) must resolve against the MOUNT, not against the scanner's own
// filesystem, and a relative link must never climb out of the mount; both are handled by resolving every path
// component by hand and re-anchoring each link target at root.
type rootFS struct{ root string }

func newRootFS(root string) rootFS { return rootFS{root: filepath.Clean(root)} }

var errEscape = errors.New("path escapes root")

const maxLinks = 16

// resolve maps a host path (absolute, e.g. /etc/nginx/nginx.conf) to a real path under root, following links within it.
func (f rootFS) resolve(hostPath string) (string, error) {
	pending := strings.Split(path.Clean("/"+hostPath), "/")
	cur := f.root
	links := 0
	for len(pending) > 0 {
		part := pending[0]
		pending = pending[1:]
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if cur == f.root {
				continue // ".." at the host root stays at the host root
			}
			cur = filepath.Dir(cur)
			continue
		}
		next := filepath.Join(cur, part)
		fi, err := os.Lstat(next)
		if err != nil {
			return "", err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			links++
			if links > maxLinks {
				return "", errors.New("too many links")
			}
			target, err := os.Readlink(next)
			if err != nil {
				return "", err
			}
			if strings.HasPrefix(target, "/") {
				cur = f.root // an absolute link is re-anchored at the mount
			}
			pending = append(strings.Split(target, "/"), pending...)
			continue
		}
		cur = next
	}
	if cur != f.root && !strings.HasPrefix(cur, f.root+string(filepath.Separator)) {
		return "", errEscape
	}
	return cur, nil
}

func (f rootFS) exists(hostPath string) bool {
	p, err := f.resolve(hostPath)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// readFile reads at most maxFile bytes of a regular file.
func (f rootFS) readFile(hostPath string) ([]byte, error) {
	p, err := f.resolve(hostPath)
	if err != nil {
		return nil, err
	}
	fh, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	st, err := fh.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	return io.ReadAll(io.LimitReader(fh, maxFile))
}

// readDir lists a directory's entry names, sorted.
func (f rootFS) readDir(hostPath string) ([]string, error) {
	p, err := f.resolve(hostPath)
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(p)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names, nil
}

// isDir reports whether the host path is a directory (after link resolution).
func (f rootFS) isDir(hostPath string) bool {
	p, err := f.resolve(hostPath)
	if err != nil {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// isSymlink reports whether the entry itself is a symlink (used to tell vendor units from custom ones).
func (f rootFS) isSymlink(hostPath string) bool {
	dir, base := path.Split(path.Clean("/" + hostPath))
	pd, err := f.resolve(dir)
	if err != nil {
		return false
	}
	fi, err := os.Lstat(filepath.Join(pd, base))
	return err == nil && fi.Mode()&os.ModeSymlink != 0
}
