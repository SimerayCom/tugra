package traffic

import (
	"encoding/json"
	"math"
	"net"
	"net/url"
	"strings"
	"unicode/utf8"
)

// record is the privacy-reduced view of one access-log line. The client address is carried only as far
// as the country/city/network derivation and is never stored in an aggregate or sent anywhere. The raw
// User-Agent and Referer are consumed inside parseLine: only the derived labels below survive.
type record struct {
	host     string // normalized request host
	path     string // query/fragment/params stripped, identifier-like segments collapsed, length-bounded
	status   int
	bytes    int64
	clientIP string
	unrouted bool // no router matched (empty RouterName): a 404 for a host Tugra does not serve

	hasUA               bool   // a User-Agent was present (so browser/os/device/bot are meaningful)
	browser, os, device string // whitelisted labels from the local UA parse, never the UA text
	bot                 bool
	referrer            string // referrer HOST only, or refDirect
	hasLat              bool   // Duration was present
	lat                 int    // index into protocol.TrafficLatencyBucketsMs (len = overflow)
}

// rawLine mirrors the Traefik v3 JSON access-log fields we keep. Everything is `any` so a value of an
// unexpected type degrades that field instead of failing the whole line.
type rawLine struct {
	ClientHost            any `json:"ClientHost"`
	RequestHost           any `json:"RequestHost"`
	RequestPath           any `json:"RequestPath"`
	DownstreamStatus      any `json:"DownstreamStatus"`
	DownstreamContentSize any `json:"DownstreamContentSize"`
	RouterName            any `json:"RouterName"`
	Duration              any `json:"Duration"` // nanoseconds

	// Kept request headers (Traefik v3 writes them flat as request_<Header>). A nested "request" object
	// is accepted too. Used only to derive labels locally; the values are never stored.
	RequestUserAgent any `json:"request_User-Agent"`
	RequestReferer   any `json:"request_Referer"`
	Request          any `json:"request"`
}

const maxPathLen = 200

// parseLine decodes one log line. ok is false for malformed lines, lines without a usable host, and
// lines excluded from the counts: the http->https redirect twin routers Tugra generates and Traefik's own
// internal routers ("*@internal").
func parseLine(line []byte) (rec record, ok bool) {
	var raw rawLine
	if err := json.Unmarshal(line, &raw); err != nil {
		return record{}, false
	}
	router := asString(raw.RouterName)
	if excludedRouter(router) {
		return record{}, false
	}
	host := normalizeHost(asString(raw.RequestHost))
	if host == "" {
		return record{}, false
	}
	rec = record{
		host:     host,
		path:     normalizePath(asString(raw.RequestPath)),
		status:   int(clampInt(asFloat(raw.DownstreamStatus), 0, 999)),
		bytes:    clampInt(asFloat(raw.DownstreamContentSize), 0, math.MaxInt32*64),
		clientIP: asString(raw.ClientHost),
		unrouted: router == "",
	}
	if ua := headerValue(raw.RequestUserAgent, raw.Request, "User-Agent"); ua != "" {
		rec.hasUA = true
		rec.browser, rec.os, rec.device, rec.bot = classifyUA(ua)
	}
	rec.referrer = refererHost(headerValue(raw.RequestReferer, raw.Request, "Referer"), host)
	if ns, present := asNumber(raw.Duration); present {
		rec.hasLat = true
		rec.lat = latencyBucket(ns)
	}
	return rec, true
}

// headerValue returns a kept request header from the flat key (already decoded into flat) or, failing that,
// from a nested "request" object (case-insensitive name). A list value yields its first element.
func headerValue(flat, nested any, name string) string {
	if s := headerString(flat); s != "" {
		return s
	}
	if m, ok := nested.(map[string]any); ok {
		for k, v := range m {
			if strings.EqualFold(k, name) {
				return headerString(v)
			}
		}
	}
	return ""
}

func headerString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		if len(t) > 0 {
			s, _ := t[0].(string)
			return s
		}
	}
	return ""
}

func asNumber(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// Router names Tugra emits for redirect-only routers. Traefik always reports a router as
// "<name>@<provider>" (docker, file, internal); the name is matched with the provider stripped.
const (
	appRouterPrefix     = "tugra_"               // every app router: tugra_<appId>[-d<hash>|-s<hash>]
	redirectTwinSuffix  = "-web"                 // the http->https twin of an app router
	panelRedirectRouter = "tugra-panel-redirect" // the panel's own http->https router
)

// excludedRouter reports whether a hit on this router must not be counted: Traefik's internal routers
// and Tugra's http->https redirect twins (the same visit is counted once, on the https router). It is
// deliberately not a bare "-web" suffix test: "tugra-panel-web" and a user's own "*-web" router serve
// real traffic.
func excludedRouter(router string) bool {
	name := router
	provider := ""
	if i := strings.LastIndexByte(router, '@'); i >= 0 {
		name, provider = router[:i], router[i+1:]
	}
	if provider == "internal" {
		return true
	}
	if name == panelRedirectRouter {
		return true
	}
	return strings.HasPrefix(name, appRouterPrefix) && strings.HasSuffix(name, redirectTwinSuffix)
}

const (
	maxHostLen  = 253
	maxLabelLen = 63
	maxRawHost  = maxHostLen + 16 // generous: port, brackets, whitespace
	invalidHost = "(invalid-host)"
	ipLiteral   = "(ip-literal)"
	otherHost   = "(other)" // overflow bucket (aggregator); never produced from a request host
)

// normalizeHost reduces the client-controlled Host header to a bounded, safe label: a lowercase RFC-1123
// hostname (letters, digits, '-', '_', '.') with port and trailing dot removed. An IP literal folds into
// ipLiteral and anything else that is not a hostname into invalidHost, so an attacker-chosen string can
// never reach the hub verbatim. Empty input yields "" (the line is skipped).
func normalizeHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if h == "" {
		return ""
	}
	if len(h) > maxRawHost {
		return invalidHost
	}
	h = strings.TrimSuffix(h, ".") // "host:443." and "host." alike
	if h == "" {
		return ""
	}
	if i := strings.IndexAny(h, "?#/\\"); i >= 0 { // never part of a host: cut, then validate what is left
		h = strings.TrimSpace(h[:i])
		if h == "" {
			return invalidHost
		}
	}
	if strings.HasPrefix(h, "[") { // [v6]:port or [v6]
		end := strings.IndexByte(h, ']')
		if end <= 0 || !validPortSuffix(h[end+1:]) || net.ParseIP(h[1:end]) == nil {
			return invalidHost
		}
		return ipLiteral
	}
	if net.ParseIP(h) != nil { // bare IPv4 or IPv6 literal
		return ipLiteral
	}
	if strings.Count(h, ":") > 1 {
		return invalidHost
	}
	if i := strings.IndexByte(h, ':'); i >= 0 {
		if !validPortSuffix(h[i:]) {
			return invalidHost
		}
		h = h[:i]
	}
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return ""
	}
	if net.ParseIP(h) != nil {
		return ipLiteral
	}
	if !validHostname(h) {
		return invalidHost
	}
	return h
}

// validPortSuffix accepts "" or ":<1-5 digits>".
func validPortSuffix(s string) bool {
	if s == "" {
		return true
	}
	if s[0] != ':' || len(s) < 2 || len(s) > 6 {
		return false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// validHostname: RFC-1123 labels (LDH, no leading/trailing hyphen) plus '_', each 1..63 bytes, 253 total.
func validHostname(h string) bool {
	if len(h) == 0 || len(h) > maxHostLen {
		return false
	}
	for _, label := range strings.Split(h, ".") {
		if len(label) == 0 || len(label) > maxLabelLen || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				return false
			}
		}
	}
	return true
}

const (
	idSegment      = ":id"
	minTokenLen    = 16 // a hex/base64-like run this long is treated as an identifier or secret
	minMixedLen    = 8  // shortest run checked at all; below minTokenLen it must mix upper, lower and digits
	maxRawPathScan = 4096
)

// normalizePath reduces a request path to a low-cardinality, secret-free shape: it cuts at the query,
// fragment and ';' path parameters (also when percent-encoded), collapses identifier-like segments
// (numbers, UUIDs, long hex/base64 runs, anything containing '@') to ":id", bounds the length and
// guarantees a leading slash. Paths with control characters or invalid UTF-8 fold into otherPath.
func normalizePath(p string) string {
	if len(p) > maxRawPathScan {
		p = truncateUTF8(p, maxRawPathScan)
	}
	if i := strings.IndexAny(p, "?#;"); i >= 0 {
		p = p[:i]
	}
	p = cutEncodedDelimiter(p)
	if p == "" {
		return "/"
	}
	if !utf8.ValidString(p) || hasControl(p) {
		return otherPath
	}
	segs := strings.Split(p, "/")
	for i, seg := range segs {
		if seg == "" {
			continue
		}
		dec := seg
		if strings.IndexByte(seg, '%') >= 0 {
			if d, err := url.PathUnescape(seg); err == nil {
				dec = d
			}
			if !utf8.ValidString(dec) || hasControl(dec) {
				return otherPath
			}
		}
		if identifierLike(dec) {
			segs[i] = idSegment
		}
	}
	p = strings.Join(segs, "/")
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if len(p) > maxPathLen {
		p = truncateUTF8(p, maxPathLen)
	}
	return p
}

// cutEncodedDelimiter cuts at the first percent-encoded '?', '#' or ';' (%3f, %23, %3b, any case).
func cutEncodedDelimiter(p string) string {
	for i := 0; i+2 < len(p); i++ {
		if p[i] != '%' {
			continue
		}
		switch strings.ToLower(p[i+1 : i+3]) {
		case "3f", "23", "3b":
			return p[:i]
		}
	}
	return p
}

func hasControl(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return true
		}
	}
	return false
}

// identifierLike reports whether a decoded path segment looks like an identifier, token or personal
// value rather than a route name: all digits, an e-mail-ish value, a UUID, or (in the whole segment or
// any dot-separated part) a hex or mixed alphanumeric/base64-url run of at least minTokenLen bytes.
func identifierLike(seg string) bool {
	if strings.IndexByte(seg, '@') >= 0 || allDigits(seg) || isUUID(seg) {
		return true
	}
	if tokenLike(seg) {
		return true
	}
	if strings.IndexByte(seg, '.') >= 0 {
		for _, part := range strings.Split(seg, ".") {
			if tokenLike(part) {
				return true
			}
		}
	}
	return false
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !isHex(c) {
			return false
		}
	}
	return true
}

func isHex(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }

// tokenLike: a run of base64/base64url characters (letters, digits, '-', '_', '+', '=') that is either at
// least minTokenLen bytes and all hex or mixing letters with digits, or at least minMixedLen bytes and mixes
// upper case, lower case and digits. Pure-letter runs are kept: they are words and slugs, not secrets.
func tokenLike(s string) bool {
	if len(s) < minMixedLen {
		return false
	}
	hex, lower, upper, digits := true, false, false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			digits = true
		case c >= 'a' && c <= 'z':
			lower = true
		case c >= 'A' && c <= 'Z':
			upper = true
		case c == '-' || c == '_' || c == '+' || c == '=':
		default:
			return false
		}
		if !isHex(c) {
			hex = false
		}
	}
	if len(s) >= minTokenLen && (hex || ((lower || upper) && digits)) {
		return true
	}
	return lower && upper && digits
}

func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 { // do not cut inside a multi-byte rune
		n--
	}
	return s[:n]
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		return 0
	}
	return 0
}

func clampInt(f float64, lo, hi int64) int64 {
	if math.IsNaN(f) || f < float64(lo) {
		return lo
	}
	if f > float64(hi) {
		return hi
	}
	return int64(f)
}
