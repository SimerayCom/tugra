package migrate

import (
	"context"
	"crypto"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Opt-in ACME certificate seeding for the Coolify -> Tugra SSL cutover (`migrate --certs`).
//
// The source host's Traefik proxy keeps its Let's Encrypt state in acme.json. We read ONLY the
// issued certificates for the hostnames the hub says it wants, and send those (cert chain + private
// key) to the hub so the new proxy can serve the same certs the moment DNS flips, without a fresh
// issuance (rate limits / downtime). Invariants:
//
//   - The ACME ACCOUNT (the "Account" object, which holds the account private key) is NEVER decoded
//     into anything, never transmitted and never logged. The struct we decode into has no Account field.
//   - No PEM or key byte is ever logged or printed: every value is registered with the scrubber and
//     the phase only ever prints counts.
//   - The store is opened read-only, must be a regular file, and is never reached through a symlink.

const (
	acmeMaxFileBytes = 8 << 20  // acme.json cap
	acmeMaxCerts     = 500      // entries considered
	acmeMaxPEMBytes  = 64 << 10 // each decoded PEM (cert chain / key)
	acmePutChunkSize = 1 << 20  // soft cap per PUT body; the hub's raw-body limit is 2 MiB

	defaultProxyContainer = "coolify-proxy"
)

// acmeFallbackPath is where Coolify keeps the proxy dir by default. Package var: test seam.
var acmeFallbackPath = "/data/coolify/proxy/acme.json"

// acmeNow is the clock used for expiry checks. Package var: test seam.
var acmeNow = time.Now

var proxyContainerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// AcmeCert is one issued certificate. CertPEM/KeyPEM are the base64-DECODED PEM texts from acme.json.
type AcmeCert struct {
	Main    string   `json:"main"`
	Sans    []string `json:"sans,omitempty"`
	CertPEM string   `json:"certPem"`
	KeyPEM  string   `json:"keyPem"`
}

// CertsBundle is the body of PUT /certs.
type CertsBundle struct {
	ServerRef string     `json:"serverRef"`
	Certs     []AcmeCert `json:"certs"`
}

// ParseStats is the count-only account of a parse (safe to print).
//
// Total = entries considered (capped at acmeMaxCerts). Of those, DroppedNotWanted did not name a
// wanted host; Matched did. Of the matched, DroppedExpired / DroppedMalformed were discarded; the
// rest are returned (minus same-main duplicates, which keep the later NotAfter).
type ParseStats struct {
	Total, Matched, DroppedNotWanted, DroppedExpired, DroppedMalformed int
}

var (
	errAcmeUnavailable = errors.New("acme store unavailable")
	errAcmeTooLarge    = errors.New("acme store too large")
)

// ---- locating the store ---------------------------------------------------------------------

type inspectMount struct {
	Type        string `json:"Type"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
}

// FindAcmeStore returns the HOST path of the proxy's acme.json. It `docker inspect`s the proxy
// container (container is its name, default "coolify-proxy") and looks for the mount holding
// Traefik's storage; if inspect fails or nothing matches it falls back to acmeFallbackPath. The
// result is verified to be a regular, non-symlink file.
func FindAcmeStore(ctx context.Context, dockerPath, container string, env []string) (string, error) {
	p := acmeFallbackPath
	if found, ok := inspectAcmePath(ctx, dockerPath, container, env); ok {
		p = found
	}
	if err := checkRegularNoSymlink(p); err != nil {
		return "", err
	}
	return p, nil
}

func inspectAcmePath(ctx context.Context, dockerPath, container string, env []string) (string, bool) {
	if !proxyContainerRe.MatchString(container) {
		return "", false
	}
	cctx, cancel := context.WithTimeout(ctx, dockerCallTimeout)
	defer cancel()
	out, _, err := runDocker(cctx, []string{dockerPath, "inspect", "--format", "{{json .Mounts}}", container}, env)
	if err != nil {
		return "", false
	}
	var mounts []inspectMount
	if json.Unmarshal(out, &mounts) != nil {
		return "", false
	}
	for _, m := range mounts {
		if !isCleanAbs(m.Source) || !isCleanAbs(m.Destination) {
			continue
		}
		switch {
		case path.Base(m.Destination) == "acme.json":
			// the file itself is bind-mounted
			if path.Base(m.Source) == "acme.json" {
				return m.Source, true
			}
		case m.Destination == "/traefik" || m.Destination == "/letsencrypt":
			return path.Join(m.Source, "acme.json"), true
		}
	}
	return "", false
}

func isCleanAbs(p string) bool {
	return p != "" && path.IsAbs(p) && path.Clean(p) == p && !strings.ContainsRune(p, 0)
}

// checkRegularNoSymlink Lstats p: it must exist and be a regular file (never a symlink).
func checkRegularNoSymlink(p string) error {
	fi, err := os.Lstat(p)
	if err != nil {
		return errAcmeUnavailable
	}
	if !fi.Mode().IsRegular() {
		return errAcmeUnavailable // symlink, directory, device, ...
	}
	return nil
}

// openAcmeStore opens p read-only after re-checking it is a regular non-symlink file, and verifies
// the opened handle is the same file that was Lstat'ed (closes the check/open swap race).
func openAcmeStore(p string) (*os.File, error) {
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return nil, errAcmeUnavailable
	}
	f, err := os.OpenFile(p, os.O_RDONLY, 0)
	if err != nil {
		return nil, errAcmeUnavailable
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || !os.SameFile(fi, st) {
		_ = f.Close()
		return nil, errAcmeUnavailable
	}
	return f, nil
}

// ---- parsing --------------------------------------------------------------------------------

// rawAcmeResolver deliberately has NO Account field: encoding/json skips unknown keys without
// retaining them, so the account key never lands in a Go value we own.
type rawAcmeResolver struct {
	Certificates []rawAcmeCert `json:"Certificates"`
}

type rawAcmeCert struct {
	Domain struct {
		Main string   `json:"main"`
		Sans []string `json:"sans"`
	} `json:"domain"`
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}

// ParseAcmeStore reads an acme.json and returns the usable certs for the wanted hosts.
//
// Rules: every top-level key is a resolver (any name, iterated in sorted order); "Account" is never
// read. Entries are considered up to acmeMaxCerts. An entry with no domain is malformed; one whose
// main and sans (lowercased) are all absent from wanted is dropped as not-wanted; otherwise the
// certificate/key are base64-decoded (std alphabet, padding optional, whitespace ignored), must each be
// <= 64 KiB and PEM-decodable, the first CERTIFICATE block must parse, the first private-key block
// (PKCS#8 / PKCS#1 / SEC1) must parse and its public half must equal the certificate's, and NotAfter
// must not be in the past. Same-main duplicates keep the later NotAfter. A file over 8 MiB is an error.
func ParseAcmeStore(r io.Reader, wanted map[string]struct{}) ([]AcmeCert, ParseStats, error) {
	var stats ParseStats
	data, err := io.ReadAll(io.LimitReader(r, acmeMaxFileBytes+1))
	if err != nil {
		return nil, stats, errors.New("acme store unreadable")
	}
	if len(data) > acmeMaxFileBytes {
		return nil, stats, errAcmeTooLarge
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return nil, stats, errors.New("acme store is not valid JSON")
	}

	want := make(map[string]struct{}, len(wanted))
	for h := range wanted {
		want[strings.ToLower(strings.TrimSpace(h))] = struct{}{}
	}

	keys := make([]string, 0, len(top))
	for k := range top {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	type kept struct {
		cert     AcmeCert
		notAfter time.Time
	}
	byMain := map[string]kept{}
	var order []string // first-seen main order, for stable output

	now := acmeNow()
resolvers:
	for _, k := range keys {
		var res rawAcmeResolver
		if json.Unmarshal(top[k], &res) != nil {
			continue // not a resolver object (or wrong shape): nothing to read
		}
		for _, rc := range res.Certificates {
			if stats.Total >= acmeMaxCerts {
				break resolvers
			}
			stats.Total++

			main := strings.ToLower(strings.TrimSpace(rc.Domain.Main))
			var sans []string
			for _, s := range rc.Domain.Sans {
				if s = strings.ToLower(strings.TrimSpace(s)); s != "" {
					sans = append(sans, s)
				}
			}
			if main == "" && len(sans) == 0 {
				stats.DroppedMalformed++
				continue
			}
			if !anyWanted(want, main, sans) {
				stats.DroppedNotWanted++
				continue
			}
			stats.Matched++

			certPEM, keyPEM, leaf, ok := decodeAndVerify(rc)
			if !ok {
				stats.DroppedMalformed++
				continue
			}
			if leaf.NotAfter.Before(now) {
				stats.DroppedExpired++
				continue
			}
			if main == "" {
				main = sans[0]
			}
			c := AcmeCert{Main: main, Sans: sans, CertPEM: certPEM, KeyPEM: keyPEM}
			prev, dup := byMain[main]
			if !dup {
				order = append(order, main)
			}
			if !dup || leaf.NotAfter.After(prev.notAfter) {
				byMain[main] = kept{cert: c, notAfter: leaf.NotAfter}
			}
		}
	}

	out := make([]AcmeCert, 0, len(order))
	for _, m := range order {
		out = append(out, byMain[m].cert)
	}
	return out, stats, nil
}

func anyWanted(want map[string]struct{}, main string, sans []string) bool {
	if _, ok := want[main]; ok && main != "" {
		return true
	}
	for _, s := range sans {
		if _, ok := want[s]; ok {
			return true
		}
	}
	return false
}

// decodeAndVerify base64-decodes and validates one entry. ok=false means malformed.
func decodeAndVerify(rc rawAcmeCert) (certPEM, keyPEM string, leaf *x509.Certificate, ok bool) {
	cb, ok1 := decodeB64Capped(rc.Certificate)
	kb, ok2 := decodeB64Capped(rc.Key)
	if !ok1 || !ok2 {
		return "", "", nil, false
	}
	certBlock, _ := pem.Decode(cb)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" {
		return "", "", nil, false
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return "", "", nil, false
	}
	keyBlock, _ := pem.Decode(kb)
	if keyBlock == nil {
		return "", "", nil, false
	}
	signer, ok3 := parsePrivateKey(keyBlock)
	if !ok3 {
		return "", "", nil, false
	}
	pub, ok4 := signer.Public().(interface{ Equal(crypto.PublicKey) bool })
	if !ok4 || !pub.Equal(cert.PublicKey) {
		return "", "", nil, false
	}
	return string(cb), string(kb), cert, true
}

func parsePrivateKey(b *pem.Block) (crypto.Signer, bool) {
	switch b.Type {
	case "PRIVATE KEY":
		k, err := x509.ParsePKCS8PrivateKey(b.Bytes)
		if err != nil {
			return nil, false
		}
		s, ok := k.(crypto.Signer)
		return s, ok
	case "RSA PRIVATE KEY":
		k, err := x509.ParsePKCS1PrivateKey(b.Bytes)
		if err != nil {
			return nil, false
		}
		return k, true
	case "EC PRIVATE KEY":
		k, err := x509.ParseECPrivateKey(b.Bytes)
		if err != nil {
			return nil, false
		}
		return k, true
	}
	return nil, false
}

// decodeB64Capped decodes std base64 (padding optional, whitespace ignored) and enforces the 64 KiB
// cap on the decoded size, checking BEFORE allocating the decoded buffer.
func decodeB64Capped(s string) ([]byte, bool) {
	if s == "" || len(s) > acmeMaxPEMBytes/3*4+64 {
		return nil, false
	}
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, s)
	s = strings.TrimRight(s, "=")
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 || len(b) > acmeMaxPEMBytes {
		return nil, false
	}
	return b, true
}

// ---- the --certs phase ----------------------------------------------------------------------

// certsResult is reported in the final JSON line (field "certs") ONLY when --certs is set.
type certsResult struct {
	State    string `json:"state"` // done | partial | skipped | failed
	Reason   string `json:"reason,omitempty"`
	Sent     int    `json:"sent,omitempty"`
	Accepted int    `json:"accepted,omitempty"`
	Rejected int    `json:"rejected,omitempty"`
}

// Fixed skip reasons (never derived from file content or hub text).
const (
	certsSkipNoWanted    = "no-wanted-hosts"
	certsSkipNoStore     = "acme-store-unavailable"
	certsSkipBadStore    = "acme-store-unusable"
	certsSkipNoneMatched = "no-matching-certs"
	certsSkipHubOld      = "hub-without-cert-support"
)

// runCerts executes the opt-in certificate phase and returns its result plus a non-zero abort exit
// code only for hub errors (auth / skew / unreachable). A missing or unreadable acme.json is a
// "skipped" phase and never changes the exit code. Only counts are ever printed.
func (r *runner) runCerts(ctx context.Context) (res certsResult, code int) {
	defer func() {
		if rec := recover(); rec != nil {
			res, code = certsResult{State: "failed", Reason: "internal"}, 0
		}
	}()

	wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
	wanted, err := r.hub.CertsWanted(wctx)
	wcancel()
	if err != nil {
		return r.certsHubErr(ctx, err, "certs/wanted")
	}
	want := map[string]struct{}{}
	for _, h := range wanted.Hosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			want[h] = struct{}{}
		}
	}
	if len(want) == 0 {
		r.logf("certs: skipped (%s)", certsSkipNoWanted)
		return certsResult{State: "skipped", Reason: certsSkipNoWanted}, 0
	}

	storePath := r.c.acmeFile
	if storePath == "" {
		p, ferr := FindAcmeStore(ctx, r.dockerPath, r.c.proxyContainer, r.dockerEnv)
		if ferr != nil {
			r.logf("certs: skipped (%s)", certsSkipNoStore)
			return certsResult{State: "skipped", Reason: certsSkipNoStore}, 0
		}
		storePath = p
	}
	f, oerr := openAcmeStore(storePath)
	if oerr != nil {
		r.logf("certs: skipped (%s)", certsSkipNoStore)
		return certsResult{State: "skipped", Reason: certsSkipNoStore}, 0
	}
	certs, stats, perr := ParseAcmeStore(f, want)
	_ = f.Close()
	if perr != nil {
		r.logf("certs: skipped (%s)", certsSkipBadStore)
		return certsResult{State: "skipped", Reason: certsSkipBadStore}, 0
	}
	// Register every secret BEFORE anything downstream could log it.
	for _, c := range certs {
		registerPEM(r.sc, c.KeyPEM)
		registerPEM(r.sc, c.CertPEM)
	}
	r.logf("certs: considered %d, wanted %d, expired %d, malformed %d", stats.Total, stats.Matched, stats.DroppedExpired, stats.DroppedMalformed)
	if len(certs) == 0 {
		r.logf("certs: skipped (%s)", certsSkipNoneMatched)
		return certsResult{State: "skipped", Reason: certsSkipNoneMatched}, 0
	}

	res = certsResult{State: "done"}
	for _, chunk := range chunkCerts(certs) {
		pctx, pcancel := context.WithTimeout(ctx, 60*time.Second)
		put, perr := r.hub.PutCerts(pctx, CertsBundle{ServerRef: wanted.ServerRef, Certs: chunk})
		pcancel()
		if perr != nil {
			rr, c := r.certsHubErr(ctx, perr, "certs")
			rr.Sent, rr.Accepted, rr.Rejected = res.Sent+len(chunk), res.Accepted, res.Rejected
			return rr, c
		}
		res.Sent += len(chunk)
		res.Accepted += put.Accepted
		res.Rejected += len(put.Rejected)
	}
	if res.Rejected > 0 || res.Accepted < res.Sent {
		res.State = "partial"
	}
	r.logf("certs: sent %d, accepted %d, rejected %d", res.Sent, res.Accepted, res.Rejected)
	return res, 0
}

// certsHubErr maps a hub failure in the cert phase onto the existing exit-code conventions. An
// older hub without the endpoints (404) is a soft skip, not a failure.
func (r *runner) certsHubErr(ctx context.Context, err error, stage string) (certsResult, int) {
	if ctx.Err() == nil && kindOf(err) == KindNotFound {
		r.logf("certs: skipped (%s)", certsSkipHubOld)
		return certsResult{State: "skipped", Reason: certsSkipHubOld}, 0
	}
	code := classifyAbort(ctx, err, r.logf, stage)
	return certsResult{State: "failed", Reason: codeName(code)}, code
}

// registerPEM registers a PEM text (and its inner base64 body, the form that would appear if someone
// re-encoded it) with the scrubber.
func registerPEM(sc *scrubber, pemText string) {
	sc.add(pemText)
	sc.add(strings.TrimSpace(pemText)) // the form a logger would most likely print
	if blk, _ := pem.Decode([]byte(pemText)); blk != nil {
		sc.add(base64.StdEncoding.EncodeToString(blk.Bytes))
	}
	sc.add(base64.StdEncoding.EncodeToString([]byte(pemText)))
}

// chunkCerts splits certs so each PUT body stays comfortably under the hub's 2 MiB raw-body cap.
func chunkCerts(certs []AcmeCert) [][]AcmeCert {
	var out [][]AcmeCert
	var cur []AcmeCert
	size := 0
	for _, c := range certs {
		n := len(c.CertPEM) + len(c.KeyPEM) + len(c.Main) + 256
		for _, s := range c.Sans {
			n += len(s) + 4
		}
		// JSON escaping of PEM newlines roughly doubles their cost; budget for it.
		n += n / 40
		if len(cur) > 0 && size+n > acmePutChunkSize {
			out = append(out, cur)
			cur, size = nil, 0
		}
		cur = append(cur, c)
		size += n
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out
}

func validProxyContainer(s string) error {
	if !proxyContainerRe.MatchString(s) {
		return fmt.Errorf("--proxy-container: invalid container name")
	}
	return nil
}
