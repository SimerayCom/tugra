package traffic

import (
	"log"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// Privacy: everything in this file turns a raw, client-controlled input (User-Agent, Referer, client IP)
// into a short, bounded LABEL computed on this host. The raw input is never returned, stored or logged;
// only the label (a whitelisted browser/OS name, a device class, a referrer HOST, an anonymized network)
// can reach an aggregate. This is the "no phone-home" guarantee for the analytics dimensions.

const (
	maxUALen    = 512 // bytes of User-Agent parsed; the rest is ignored (bounds CPU on junk)
	maxRefLen   = 2048
	refDirect   = "(direct)"
	labelOther  = "Other"
	deviceOther = "other"

	ipv4NetBits = 24
	ipv6NetBits = 48
)

// IP mode: what the agent may derive from the client address. "anonymized" (default when nothing is
// configured) enables the coarse city lookup and the /24 (IPv4) or /48 (IPv6) network; "off" disables both
// (country is unaffected). Fail closed: any other non-empty value (a typo, "none", "false", "0", "full") is
// treated as "off" and reported once, so a misconfiguration never turns IP-derived data ON. There is no mode
// that keeps a full address.
//
// The mode comes from TUGRA_TRAFFIC_IP_MODE, or, when that is unset/empty, from the first line of
// ipModeFile (/etc/tugra is mounted into the agent, and survives a self-update, which re-creates the
// container without the original environment).
const (
	ipModeEnv        = "TUGRA_TRAFFIC_IP_MODE"
	ipModeFile       = "/etc/tugra/traffic-ip-mode"
	ipModeAnonymized = "anonymized"
	ipModeOff        = "off"
)

// ipModeFromEnv maps a configured value to a mode. "" and "anonymized" -> anonymized; everything else -> off.
func ipModeFromEnv(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", ipModeAnonymized:
		return ipModeAnonymized
	default:
		return ipModeOff
	}
}

// loadIPMode resolves the mode from the environment, then from file, and logs (once) an unrecognised value.
func loadIPMode(file string) string {
	v, src := os.Getenv(ipModeEnv), ipModeEnv
	if strings.TrimSpace(v) == "" {
		v, src = "", ""
		if b, err := os.ReadFile(file); err == nil {
			if len(b) > 64 {
				b = b[:64]
			}
			v, src = strings.SplitN(string(b), "\n", 2)[0], file
		} else if !os.IsNotExist(err) {
			log.Printf("traffic: cannot read %s (%v); IP-derived dimensions (city, network) are OFF", file, err)
			return ipModeOff
		}
	}
	mode := ipModeFromEnv(v)
	if t := strings.ToLower(strings.TrimSpace(v)); t != "" && t != ipModeAnonymized && t != ipModeOff {
		log.Printf("traffic: unrecognised %s value %q (accepted: %q, %q); IP-derived dimensions (city, network) are OFF",
			src, truncateUTF8(strings.TrimSpace(v), 32), ipModeAnonymized, ipModeOff)
	}
	return mode
}

// classifyUA parses a User-Agent locally into whitelisted labels (see parseUserAgent: an unknown client is
// "Other", the raw text is never echoed). The input is bounded and never retained.
func classifyUA(ua string) (browser, os, device string, bot bool) {
	ua = truncateUTF8(strings.TrimSpace(ua), maxUALen)
	p := parseUserAgent(ua)
	if p.IsBot || isAutomatedUA(ua) {
		return p.Browser, p.OS, "bot", true
	}
	return p.Browser, p.OS, p.DeviceClass, false
}

// automatedUATokens are lowercase substrings of programmatic clients, health probes and scanners that the
// name-based bot check in parseUserAgent does not catch (it only recognises bot/spider/crawler-style names).
var automatedUATokens = []string{
	"curl/", "wget", "libcurl", "python-requests", "python-urllib", "aiohttp", "httpx", "go-http-client",
	"java/", "okhttp", "apache-httpclient", "axios", "node-fetch", "undici", "postmanruntime",
	"insomnia", "libwww-perl", "lwp::", "uptime-kuma", "uptimerobot", "kube-probe", "nagios", "zabbix", "prometheus", "pingdom", "statuscake", "site24x7", "nuclei",
	"zgrab", "masscan", "sqlmap", "nmap", "nikto", "gobuster", "dirbuster", "wpscan", "censys", "shodan",
	"netcraft", "scrapy", "mechanize",
}

// isAutomatedUA reports whether the UA is a non-browser client: an empty/non-"Mozilla/" (or "Opera/") UA, or
// one carrying a known tool/probe/scanner token. Matching is local and the UA text is never retained.
func isAutomatedUA(ua string) bool {
	l := strings.ToLower(strings.TrimSpace(ua))
	if l == "" {
		return true
	}
	if !strings.HasPrefix(l, "mozilla/") && !strings.HasPrefix(l, "opera/") {
		return true
	}
	for _, t := range automatedUATokens {
		if strings.Contains(l, t) {
			return true
		}
	}
	return false
}

// refererHost reduces a Referer URL to its lowercase HOST only: scheme, userinfo, port, path, query and
// fragment are discarded. Empty, "-", unparseable, host-less and same-site (incl. www.) referrers are
// "(direct)". The request host is the already-normalized Host of the same line.
func refererHost(ref, reqHost string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" || ref == "-" {
		return refDirect
	}
	if len(ref) > maxRefLen {
		ref = truncateUTF8(ref, maxRefLen)
	}
	u, err := url.Parse(ref)
	if err != nil || u.Host == "" {
		return refDirect
	}
	h := normalizeHost(u.Host)
	if h == "" {
		return refDirect
	}
	if h == reqHost || strings.TrimPrefix(h, "www.") == strings.TrimPrefix(reqHost, "www.") {
		return refDirect
	}
	return h
}

// latencyBucket maps a duration in nanoseconds to its index in protocol.TrafficLatencyBucketsMs (inclusive
// upper bounds); an index of len(bounds) is the overflow bucket (> the last bound).
func latencyBucket(ns float64) int {
	ms := ns / 1e6
	for i, b := range protocol.TrafficLatencyBucketsMs {
		if ms <= float64(b) {
			return i
		}
	}
	return len(protocol.TrafficLatencyBucketsMs)
}

// anonymizeNetwork masks a client address to its IPv4 /24 or IPv6 /48 ("1.2.3.0/24", "2001:db8::/48").
// A full address never comes out. Non-public addresses (private, loopback, link-local, ...) and malformed
// input yield "".
func anonymizeNetwork(clientHost string) string {
	addr, ok := parseClientAddr(clientHost)
	if !ok || !publicAddr(addr) {
		return ""
	}
	// 6to4 (2002::/16) carries the client's full IPv4 in bits 16-47, which a /48 mask would keep. Reduce it
	// to the embedded IPv4's /24, exactly as a native IPv4 client is.
	if addr.Is6() && addr.As16()[0] == 0x20 && addr.As16()[1] == 0x02 {
		b := addr.As16()
		addr = netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]})
		if !publicAddr(addr) {
			return ""
		}
	}
	bits := ipv6NetBits
	if addr.Is4() {
		bits = ipv4NetBits
	}
	return netip.PrefixFrom(addr, bits).Masked().String()
}

func publicAddr(a netip.Addr) bool {
	return a.IsValid() && !a.IsPrivate() && !a.IsLoopback() && !a.IsLinkLocalUnicast() && !a.IsUnspecified() &&
		!a.IsMulticast() && !a.IsLinkLocalMulticast()
}

// cleanLabel bounds a label coming from a local database: valid UTF-8, no control characters.
func cleanLabel(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" || !utf8.ValidString(s) || hasControl(s) {
		return ""
	}
	return truncateUTF8(s, max)
}
