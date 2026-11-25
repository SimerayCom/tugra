package scan

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// collectPorts lists listening TCP sockets from /proc/net/tcp and /proc/net/tcp6 (state 0A). Run with the host network
// namespace these are the HOST's listeners. Process names are not resolved (that would need ptrace rights); the hub
// maps a port to a container or a well-known service itself, and uses the owning account (see Port.User) for native
// services on unusual ports.
func collectPorts(fs rootFS, proc string, errs *[]string) []Port {
	users := passwdUsers(fs)
	byPort := map[int]Port{}
	read := func(file string, v6 bool) {
		f, err := os.Open(filepath.Join(proc, "net", file))
		if err != nil {
			if !os.IsNotExist(err) {
				*errs = append(*errs, "ports:"+file)
			}
			return
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		first := true
		for sc.Scan() {
			if first {
				first = false
				continue
			}
			fields := strings.Fields(sc.Text())
			if len(fields) < 4 || fields[3] != "0A" {
				continue
			}
			addr, portHex, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			p, err := strconv.ParseUint(portHex, 16, 32)
			if err != nil || p == 0 || p > 65535 {
				continue
			}
			scope := "public"
			if isLoopbackHex(addr, v6) {
				scope = "local"
			}
			user := ""
			if len(fields) > 7 {
				if uid, err := strconv.Atoi(fields[7]); err == nil {
					user = users[uid]
				}
			}
			prev, seen := byPort[int(p)]
			if !seen || (prev.Scope == "local" && scope == "public") {
				byPort[int(p)] = Port{Port: int(p), Proto: "tcp", Scope: scope, User: user}
			} else if prev.User == "" && user != "" && prev.Scope == scope {
				prev.User = user
				byPort[int(p)] = prev
			}
		}
	}
	read("tcp", false)
	read("tcp6", true)
	out := make([]Port, 0, len(byPort))
	for _, p := range byPort {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	if len(out) > maxPorts {
		out = out[:maxPorts]
	}
	return out
}

// isLoopbackHex: /proc prints an IPv4 address as one little-endian 32-bit hex word and an IPv6 address as four of them.
func isLoopbackHex(addr string, v6 bool) bool {
	if !v6 {
		// 127.x.x.x → last byte (little-endian: the final two hex digits) is 0x7F.
		return len(addr) == 8 && strings.HasSuffix(strings.ToUpper(addr), "7F")
	}
	a := strings.ToUpper(addr)
	switch {
	case a == "00000000000000000000000001000000": // ::1
		return true
	case strings.HasPrefix(a, "0000000000000000FFFF0000") && strings.HasSuffix(a, "7F"): // ::ffff:127.x.x.x
		return true
	}
	return false
}

var accountNameRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// passwdUsers maps uid → account name from the host's /etc/passwd, for every NON-root account with a sane name. Root is left
// out on purpose: a root-owned listener says nothing about what it is.
func passwdUsers(fs rootFS) map[int]string {
	out := map[int]string{}
	b, err := fs.readFile("/etc/passwd")
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Split(line, ":")
		if len(f) < 3 || !accountNameRe.MatchString(f[0]) {
			continue
		}
		uid, err := strconv.Atoi(f[2])
		if err != nil || uid <= 0 {
			continue
		}
		if _, dup := out[uid]; !dup {
			out[uid] = f[0]
		}
	}
	return out
}
