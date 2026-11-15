//go:build !windows

package ctrfs

import "syscall"

// freeBytes reports the bytes available to unprivileged writers on the filesystem holding dir.
func freeBytes(dir string) (uint64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), true //nolint:unconvert // field widths differ per OS
}
