//go:build !(linux || darwin || freebsd || netbsd || openbsd)

package traffic

import "os"

// mapFile reads the whole database into memory on platforms without the mmap path.
func mapFile(path string) (data []byte, release func() error, err error) {
	data, err = os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	return data, func() error { return nil }, nil
}
