//go:build linux || darwin || freebsd || netbsd || openbsd

package traffic

import (
	"errors"
	"os"
	"syscall"
)

// mapFile maps a database file read-only into memory (city databases can be >100 MB, so it is not copied onto
// the heap). release unmaps it; the caller must not touch the slice afterwards.
func mapFile(path string) (data []byte, release func() error, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	size := st.Size()
	if size <= 0 || int64(int(size)) != size {
		return nil, nil, errors.New("mmdb: file empty or too large")
	}
	data, err = syscall.Mmap(int(f.Fd()), 0, int(size), syscall.PROT_READ, syscall.MAP_SHARED)
	if err != nil {
		return nil, nil, err
	}
	return data, func() error { return syscall.Munmap(data) }, nil
}
