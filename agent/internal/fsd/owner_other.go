//go:build !linux

package fsd

import "io/fs"

// ownerOf is unavailable off Linux (the helper only ever runs in a Linux container); callers treat ok=false as
// "ownership unknown" and skip chown, so developer builds on macOS still compile and unit-test.
func ownerOf(fs.FileInfo) (uid, gid int, ok bool) { return 0, 0, false }
