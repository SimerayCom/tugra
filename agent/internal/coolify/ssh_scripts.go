package coolify

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"strings"
)

// The probe and the uninstall script are part of the agent: the hub only sends their sha256 and the agent runs the copy it carries, so a
// hub (or anything pretending to be one) cannot make this path run another script. The install script is rendered by the hub for its
// release and is bound by the signed hash instead.

//go:embed scripts/probe.sh
var probeScript string

//go:embed scripts/uninstall.sh
var uninstallScript string

// Sha256Hex is the lower-case hex sha256 of s.
func Sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ScriptFor returns the embedded script of op ("probe", "uninstall"), or false for an op that has none (install).
func ScriptFor(op string) (string, bool) {
	switch op {
	case "probe":
		return probeScript, true
	case "uninstall":
		return uninstallScript, true
	}
	return "", false
}

// ScriptSha256 is the hash the hub must name for op's embedded script ("" for install).
func ScriptSha256(op string) string {
	if s, ok := ScriptFor(op); ok {
		return Sha256Hex(s)
	}
	return ""
}

// shQuote single-quotes a value for the prefix lines (it never holds a quote: callers validate the charset first, this is a second wall).
func shQuote(v string) string { return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'" }

// Prefix builds the `export` lines placed before a script on stdin. Values only ever travel here, never as an argument of the ssh command.
func Prefix(pairs ...[2]string) string {
	var b strings.Builder
	for _, p := range pairs {
		if p[1] == "" {
			continue
		}
		b.WriteString("export " + p[0] + "=" + shQuote(p[1]) + "\n")
	}
	return b.String()
}
