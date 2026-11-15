package fsd

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// Req2 is one fs2 helper request (everything the launcher may put on the helper's argv).
type Req2 struct {
	Op, Path, Path2, Mode, Flags, Sha256, IfMatch string
	Size                                          int64
}

var (
	sha256HexRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	ifMatchRe   = regexp.MustCompile(`^\d{1,20}-\d{1,20}$`)
)

// readOps run with the read-only profile; every other known op needs the read-write one.
var (
	readOps2  = map[string]bool{"stat": true, "read": true}
	writeOps2 = map[string]bool{"write": true, "mkdir": true, "rename": true, "chmod": true, "delete": true}
)

// BuildHelperArgs2 builds the `docker run` argv for the fsd2 helper. Every attacker-reachable field is
// re-validated here (volume, op, image, container name, path, mode, flags, sha256, ifMatch), and every user value
// travels as ONE `--key=value` argv element so a leading '-' can never be parsed as an option.
//
// Two profiles, both ephemeral, network-less, read-only-rootfs, no-new-privileges, pids/memory bounded, with ONLY
// the target volume mounted (never docker.sock, a host path or env):
//   - read class (stat, read): the EXISTING list hardening exactly — cap-drop ALL + DAC_READ_SEARCH, volume
//     mounted READ-ONLY.
//   - mutating class (write, mkdir, rename, chmod, delete): cap-drop ALL + CHOWN (hand new files to the volume's
//     owner), DAC_OVERRIDE (root-in-container must be able to write into a dir owned by the app uid) and FOWNER
//     (chmod/utimes on files the app owns); the volume is mounted READ-WRITE. DAC_OVERRIDE already implies
//     read/search, so DAC_READ_SEARCH is not added. No FSETID/MKNOD/SETUID/SYS_ADMIN, never --privileged.
//
// `--mount type=volume,src=<name>` (not -v) can never fall back to a host bind from a path-like source, and the
// volume charset forbids ':' ',' '=' so no extra mount fields can be smuggled. Only `write` gets `-i` (the body
// arrives on stdin); needsStdin reports it.
func BuildHelperArgs2(image, volume string, r Req2, name string) (args []string, needsStdin bool, err error) {
	if err := validateVolume(volume); err != nil {
		return nil, false, err
	}
	isRead, isWrite := readOps2[r.Op], writeOps2[r.Op]
	if !isRead && !isWrite {
		return nil, false, errors.New("unsupported op")
	}
	if image == "" || strings.HasPrefix(image, "-") {
		return nil, false, errors.New("invalid image reference")
	}
	if !nameRe.MatchString(name) {
		return nil, false, errors.New("invalid container name")
	}
	if err := validatePath2(r.Path, r.Op == "stat"); err != nil {
		return nil, false, err
	}
	if r.Op == "rename" {
		if err := validatePath2(r.Path2, false); err != nil {
			return nil, false, err
		}
	} else if r.Path2 != "" {
		return nil, false, errors.New("unexpected path2")
	}
	if r.Mode != "" {
		if _, err := validateMode(r.Mode); err != nil {
			return nil, false, err
		}
	}
	if r.Op == "chmod" && r.Mode == "" {
		return nil, false, errors.New("mode is required")
	}
	if !flagsRe.MatchString(r.Flags) || hasDupByte(r.Flags) {
		return nil, false, errors.New("invalid flags")
	}
	if r.Sha256 != "" && !sha256HexRe.MatchString(r.Sha256) {
		return nil, false, errors.New("invalid sha256")
	}
	if r.IfMatch != "" && !ifMatchRe.MatchString(r.IfMatch) {
		return nil, false, errors.New("invalid ifMatch")
	}
	if r.Size < 0 {
		return nil, false, errors.New("invalid size")
	}

	a := []string{"docker", "run", "--rm"}
	if r.Op == "write" {
		a = append(a, "-i")
	}
	a = append(a, "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL")
	if isRead {
		a = append(a, "--cap-add", "DAC_READ_SEARCH")
	} else {
		a = append(a, "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER")
	}
	a = append(a, "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m")
	if isRead {
		a = append(a, "--mount", "type=volume,src="+volume+",dst=/data,readonly,volume-nocopy")
	} else {
		a = append(a, "--mount", "type=volume,src="+volume+",dst=/data,volume-nocopy")
	}
	a = append(a, "--entrypoint", "tugra-agent", image, "fsd2", r.Op, "--path="+r.Path)
	if r.Path2 != "" {
		a = append(a, "--path2="+r.Path2)
	}
	if r.Mode != "" {
		a = append(a, "--mode="+r.Mode)
	}
	if r.Op == "write" || r.Op == "read" {
		a = append(a, "--size="+strconv.FormatInt(r.Size, 10))
	}
	if r.Sha256 != "" {
		a = append(a, "--sha256="+r.Sha256)
	}
	if r.Flags != "" {
		a = append(a, "--flags="+r.Flags)
	}
	if r.IfMatch != "" {
		a = append(a, "--if-match="+r.IfMatch)
	}
	return a, r.Op == "write", nil
}

func hasDupByte(s string) bool {
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(s[i+1:], s[i]) >= 0 {
			return true
		}
	}
	return false
}
