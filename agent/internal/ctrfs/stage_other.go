//go:build windows

package ctrfs

// freeBytes is unavailable here; the staging copy still maps ENOSPC to no_space.
func freeBytes(string) (uint64, bool) { return 0, false }
