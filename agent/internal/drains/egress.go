package drains

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// Egress policies (computed by the hub, never user-supplied).
const (
	egressPublic = "public"
	egressAny    = "any"
)

// errEgressDenied marks a dial refused by the egress guard (classified "policy", permanent).
var errEgressDenied = errors.New("egress denied by policy")

var (
	cgnat      = netip.MustParsePrefix("100.64.0.0/10")
	awsIMDSv6  = netip.MustParseAddr("fd00:ec2::254")
	nat64      = netip.MustParsePrefix("64:ff9b::/96")
	linkLocal4 = netip.MustParsePrefix("169.254.0.0/16")
)

// checkEgressIP applies the policy to ONE resolved address. ALWAYS denied (every policy): link-local (which
// covers the 169.254.169.254 cloud metadata endpoint), fe80::/10, fd00:ec2::254, the unspecified address and
// multicast. Policy "public" additionally denies loopback, RFC1918, 100.64.0.0/10 and fc00::/7. IPv4-mapped and
// NAT64-embedded IPv4 addresses are unwrapped first so they cannot smuggle a denied v4 range past the check.
func checkEgressIP(policy string, a netip.Addr) error {
	a = a.Unmap()
	if a.Is6() && nat64.Contains(a) {
		b := a.As16()
		a = netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})
	}
	if a.IsUnspecified() || a.IsMulticast() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		linkLocal4.Contains(a) || a == awsIMDSv6 {
		return errEgressDenied
	}
	if policy != egressAny { // "public" and any unknown value get the strict set (fail closed)
		if a.IsLoopback() || a.IsPrivate() || cgnat.Contains(a) {
			return errEgressDenied
		}
	}
	return nil
}

// guardedDialer returns a dialer whose Control hook sees the RESOLVED "ip:port" of every connection attempt, so a
// hostname that resolves (or rebinds, or redirects) to a denied address is blocked after resolution.
func guardedDialer(policy string) *net.Dialer {
	return &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil {
				return errEgressDenied
			}
			return checkEgressIP(policy, ap.Addr())
		},
	}
}

// guardedTransport is the HTTP transport for sinks with an egress policy: no proxy (an env proxy would defeat
// the guard), dial through the guarded dialer, so redirects are re-checked on every new connection.
func guardedTransport(policy string) *http.Transport {
	d := guardedDialer(policy)
	return &http.Transport{
		Proxy:               nil,
		DialContext:         d.DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		MaxIdleConns:        4,
		IdleConnTimeout:     60 * time.Second,
	}
}
