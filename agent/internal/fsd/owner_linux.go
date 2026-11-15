//go:build linux

package fsd

import (
	"io/fs"
	"syscall"
)

// ownerOf returns the numeric uid/gid of a stat result (never follows anything; fi comes from Lstat/Stat).
func ownerOf(fi fs.FileInfo) (uid, gid int, ok bool) {
	st, isStat := fi.Sys().(*syscall.Stat_t)
	if !isStat || st == nil {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}
