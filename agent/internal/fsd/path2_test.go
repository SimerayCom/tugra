package fsd

import (
	"strings"
	"testing"
)

func TestValidatePath2(t *testing.T) {
	long := strings.Repeat("a", 256)
	deep := strings.Repeat("a/", 64) + "a" // 65 segments
	ok64 := strings.TrimSuffix(strings.Repeat("a/", 64), "/")
	bad := map[string]string{
		"nul":       "a\x00b",
		"c0":        "a\x01b",
		"newline":   "a\nb",
		"tab":       "a\tb",
		"del":       "a\x7fb",
		"backslash": `a\b`,
		"absolute":  "/etc/passwd",
		"dotdot":    "a/../b",
		"leaddd":    "../a",
		"dot":       "a/./b",
		"lonedot":   ".",
		"empty seg": "a//b",
		"trailing":  "a/",
		"seg>255":   "a/" + long,
		"depth>64":  deep,
		"total":     strings.Repeat("a/", 2049),
		"part":      ".tugra-part-0123456789abcdef",
		"part deep": "a/.tugra-part-x/b",
		"bad utf8":  "a\xffb",
		"empty":     "",
	}
	for name, p := range bad {
		if err := validatePath2(p, false); err == nil {
			t.Errorf("%s: %q accepted", name, p)
		}
	}
	for _, p := range []string{"a", "dir/h\u00e9llo.txt", ".hidden", "a b/c", "-rf", "..a", "a..", ok64, strings.Repeat("a", 255), ".tugra-par"} {
		if err := validatePath2(p, false); err != nil {
			t.Errorf("%q refused: %v", p, err)
		}
	}
	if validatePath2("", true) != nil {
		t.Error("allowRoot must permit the empty path")
	}
	if validatePath2("", false) == nil {
		t.Error("empty path must be refused when the root is not allowed")
	}
}

func TestValidateMode(t *testing.T) {
	for in, want := range map[string]uint32{"0644": 0o644, "755": 0o755, "0777": 0o777, "000": 0, "0600": 0o600} {
		got, err := validateMode(in)
		if err != nil || uint32(got) != want {
			t.Errorf("validateMode(%q) = %o,%v want %o", in, got, err, want)
		}
	}
	for _, in := range []string{"4755", "1777", "2755", "9", "0o", "", "12", "01234", "0x1", "-644", "07 7", "0888"} {
		if _, err := validateMode(in); err == nil {
			t.Errorf("validateMode(%q) accepted", in)
		}
	}
}
