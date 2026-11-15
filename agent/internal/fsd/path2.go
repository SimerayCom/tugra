package fsd

import (
	"errors"
	"io/fs"
	"strconv"
	"strings"
	"unicode/utf8"
)

// partPrefix marks the helper's in-flight upload temp files. No user path may name one (so a client can never
// read, rename over or delete another upload's temp), and listings hide them.
const partPrefix = ".tugra-part-"

const (
	maxSegmentBytes = 255
	maxSegments     = 64
)

// validatePath2 is the strict path check of the write-capable helper (fsd2). Unlike the legacy validatePath
// (kept untouched for `list`) it also refuses control characters, empty and "." segments (so no "//" and no
// trailing slash), over-long segments, deep trees and the helper's own temp names. A volume-relative path only.
// allowRoot permits "" (the volume root) and is meant for stat only.
func validatePath2(p string, allowRoot bool) error {
	if p == "" {
		if allowRoot {
			return nil
		}
		return errors.New("path is required")
	}
	if len(p) > maxPathLen {
		return errors.New("path too long")
	}
	if !utf8.ValidString(p) {
		return errors.New("path is not valid UTF-8")
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch {
		case c == 0:
			return errors.New("path contains a NUL byte")
		case c < 0x20 || c == 0x7f:
			return errors.New("path contains a control character")
		case c == '\\':
			return errors.New("backslash is not allowed in a path")
		}
	}
	if strings.HasPrefix(p, "/") {
		return errors.New("absolute paths are not allowed")
	}
	segs := strings.Split(p, "/")
	if len(segs) > maxSegments {
		return errors.New("path is nested too deeply")
	}
	for _, seg := range segs {
		switch {
		case seg == "" || seg == "." || seg == "..":
			return errors.New("empty, '.' and '..' path segments are not allowed")
		case len(seg) > maxSegmentBytes:
			return errors.New("path segment too long")
		case strings.HasPrefix(seg, partPrefix):
			return errors.New("reserved name")
		}
	}
	return nil
}

// validateMode parses a 3-4 digit octal permission string. Anything above 0777 (setuid, setgid, sticky) is
// refused: the file manager never sets special bits.
func validateMode(s string) (fs.FileMode, error) {
	if len(s) < 3 || len(s) > 4 {
		return 0, errors.New("mode must be 3 or 4 octal digits")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '7' {
			return 0, errors.New("mode must be octal")
		}
	}
	v, err := strconv.ParseUint(s, 8, 32)
	if err != nil {
		return 0, errors.New("mode must be octal")
	}
	if v > 0o777 {
		return 0, errors.New("setuid, setgid and sticky bits are not allowed")
	}
	return fs.FileMode(v), nil
}
