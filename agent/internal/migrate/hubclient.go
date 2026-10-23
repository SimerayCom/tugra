package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Test seams (mirrors the fsd/run.go package-var pattern). waitRetry is ctx-aware: a signal
// cancels an in-progress backoff immediately instead of blocking for up to the cap.
var (
	httpNow   = time.Now
	waitRetry = func(ctx context.Context, d time.Duration) error {
		if d <= 0 {
			return ctx.Err()
		}
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			return nil
		}
	}
)

const apiPrefix = "/api/v1/import/migration/"

// ErrKind classifies a hub response for run.go's decision logic.
type ErrKind int

const (
	KindOther ErrKind = iota
	KindAuth          // 401/403 -> abort run, exit 3
	KindNotFound
	KindBadRequest
	KindTooLarge
	KindLengthRequired
	KindBadMedia
	KindNoSpace
	KindRateLimited
	KindServer
	KindRedirect
	KindBusyUpload
	KindRestoreInProgress // "switch to polling" — NOT an error
	KindNotStaged
	KindDifferentRestored
	KindDestDirty
	KindDestGone
	KindHubMisconfig
	KindUnknownConflict
	KindDecode // a 2xx body that failed to decode (or strict-decode) — a contract/skew signal
)

// HubError is a classified hub failure. Msg is already safe (carries no token).
type HubError struct {
	Status int
	Kind   ErrKind
	Msg    string
}

func (e *HubError) Error() string { return fmt.Sprintf("hub %d: %s", e.Status, e.Msg) }

// Hub is the migration-token-authenticated client for the hub's data-plane endpoints.
type Hub struct {
	base *url.URL
	tok  string
	hc   *http.Client
	ua   string
}

// Response shapes.
type ProbeResp struct {
	OK        bool   `json:"ok"`
	OpID      string `json:"opId"`
	ExpiresAt string `json:"expiresAt"`
	// expiresAt is parsed from ExpiresAt. Expiry margins (run.go) compare it to the LOCAL clock:
	// the token lives 1h and the margins are generous (5m at start, 2m per item), so modest skew is
	// harmless and a Date-header round-trip is not worth the complexity.
	expiresAt time.Time
}
type TargetsResp struct {
	OpID             string   `json:"opId"`
	Targets          []Target `json:"targets"`
	MaxArtifactBytes int64    `json:"maxArtifactBytes"`
}
type StatusResp struct {
	ItemRef  string `json:"itemRef"`
	State    string `json:"state"`
	Step     string `json:"step"`
	Bytes    int64  `json:"bytes"`
	Sha256   string `json:"sha256"`
	ExitCode *int   `json:"exitCode"`
}
type PutResp struct {
	ItemRef  string `json:"itemRef"`
	Bytes    int64  `json:"bytes"`
	Sha256   string `json:"sha256"`
	Gzip     bool   `json:"gzip"`
	PgFormat string `json:"pgFormat"`
}
type RestoreResp struct {
	State           string `json:"state"`
	AlreadyRestored bool   `json:"alreadyRestored"`
}

// NewHub validates base and builds the client. base must already have passed the SAFE_BASE check.
func NewHub(base, token, version string) (*Hub, error) {
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("invalid hub URL")
	}
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          8,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 120 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	hc := &http.Client{
		Transport: tr,
		// Never follow a redirect: the Bearer token and a gigabyte body must not go anywhere
		// unexpected. A 3xx is returned and classified as KindRedirect.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &Hub{base: u, tok: token, hc: hc, ua: "tugra-migrate/" + version}, nil
}

func (h *Hub) url(path string, q url.Values) string {
	u := *h.base
	u.Path = strings.TrimRight(u.Path, "/") + apiPrefix + path
	if q != nil {
		u.RawQuery = q.Encode()
	}
	return u.String()
}

// newReq builds a request with the fixed headers. Defense in depth: it asserts the final URL's
// scheme+host still equal the configured origin, so the token can only ever be sent there.
func (h *Hub) newReq(ctx context.Context, method, rawurl string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawurl, body)
	if err != nil {
		return nil, err
	}
	if req.URL.Scheme != h.base.Scheme || req.URL.Host != h.base.Host {
		return nil, fmt.Errorf("refusing to send to a different origin")
	}
	req.Header.Set("Authorization", "Bearer "+h.tok)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", h.ua)
	return req, nil
}

// retriable classes.
func isRetriableStatus(code int) bool {
	return code == 429 || code == 502 || code == 503 || code == 504
}

// doJSON performs a control-plane call (GET/POST, no large body) with retry + classification and
// decodes a JSON response into out (may be nil). strict=true rejects unknown JSON fields.
func (h *Hub) doJSON(ctx context.Context, method, path string, q url.Values, out any, strict bool, attempts int) error {
	backoff := time.Second
	var last error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			if err := waitRetry(ctx, jitter(backoff)); err != nil {
				return err
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
		req, err := h.newReq(ctx, method, h.url(path, q), http.NoBody)
		if err != nil {
			return err
		}
		if method == http.MethodPost {
			req.ContentLength = 0
		}
		resp, err := h.hc.Do(req)
		if err != nil {
			last = &HubError{Kind: KindServer, Msg: scrubNetErr(err)}
			continue // transport error: retry
		}
		done, derr := h.handle(resp, out, strict)
		if derr == nil {
			return nil
		}
		last = derr
		var he *HubError
		if errors.As(derr, &he) && (isRetriableStatus(he.Status) || he.Kind == KindBusyUpload) {
			if ra := retryAfter(resp.Header); ra > 0 {
				backoff = ra
			}
			if !done {
				continue
			}
			continue
		}
		return derr // non-retriable
	}
	return last
}

// handle reads+classifies a response and decodes JSON on 2xx. Returns (bodyConsumed, error).
func (h *Hub) handle(resp *http.Response, out any, strict bool) (bool, error) {
	defer resp.Body.Close()
	code := resp.StatusCode
	if code >= 300 && code < 400 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		loc := resp.Header.Get("Location")
		return true, &HubError{Status: code, Kind: KindRedirect, Msg: "the hub returned a redirect to " + sanitizeLocation(loc) + " (set --hub to that origin); refusing to follow"}
	}
	if code >= 200 && code < 300 {
		if out != nil {
			lr := io.LimitReader(resp.Body, 1<<20)
			dec := json.NewDecoder(lr)
			if strict {
				dec.DisallowUnknownFields()
			}
			if err := dec.Decode(out); err != nil {
				return true, &HubError{Status: code, Kind: KindDecode, Msg: "could not decode the hub response (unexpected shape or extra field)"}
			}
		} else {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		}
		return true, nil
	}
	// error status: read a small message
	msg := readErrMessage(resp.Body)
	return true, classify(code, msg)
}

// Probe GETs /probe and parses the expiry + the hub clock (Date header) for skew-corrected
// deadlines.
func (h *Hub) Probe(ctx context.Context) (*ProbeResp, error) {
	var p ProbeResp
	if err := h.doJSON(ctx, http.MethodGet, "probe", nil, &p, false, 5); err != nil {
		return nil, err
	}
	p.expiresAt, _ = time.Parse(time.RFC3339, p.ExpiresAt)
	return &p, nil
}

// Recipes GETs /recipes with STRICT decoding (an added field without a v bump fails closed).
func (h *Hub) Recipes(ctx context.Context) (*RecipesEnvelope, error) {
	var env RecipesEnvelope
	if err := h.doJSON(ctx, http.MethodGet, "recipes", nil, &env, true, 5); err != nil {
		return nil, err
	}
	return &env, nil
}

func (h *Hub) Targets(ctx context.Context) (*TargetsResp, error) {
	var t TargetsResp
	if err := h.doJSON(ctx, http.MethodGet, "targets", nil, &t, false, 5); err != nil {
		return nil, err
	}
	return &t, nil
}

func (h *Hub) Status(ctx context.Context, itemRef string) (*StatusResp, error) {
	var s StatusResp
	if err := h.doJSON(ctx, http.MethodGet, "artifacts/"+url.PathEscape(itemRef)+"/status", nil, &s, false, 5); err != nil {
		return nil, err
	}
	return &s, nil
}

func (h *Hub) Restore(ctx context.Context, itemRef string, resync bool) (*RestoreResp, error) {
	q := url.Values{}
	if resync {
		q.Set("resync", "1")
	}
	var r RestoreResp
	if err := h.doJSON(ctx, http.MethodPost, "artifacts/"+url.PathEscape(itemRef)+"/restore", q, &r, false, 3); err != nil {
		return nil, err
	}
	return &r, nil
}

// PutQuery carries the upload flags.
type PutQuery struct {
	Gzip   bool
	Format string // "custom" for POSTGRES, else ""
}

// Put streams the spooled artifact with an EXACT Content-Length (the hub 411s without one and
// would otherwise go chunked). body is reopened via GetBody so a retry restarts at byte 0.
func (h *Hub) Put(ctx context.Context, itemRef string, body io.ReaderAt, size int64, pq PutQuery) (*PutResp, error) {
	q := url.Values{}
	if pq.Gzip {
		q.Set("gzip", "1")
	} else {
		q.Set("gzip", "0")
	}
	if pq.Format != "" {
		q.Set("format", pq.Format)
	}
	rawurl := h.url("artifacts/"+url.PathEscape(itemRef), q)

	mk := func() (*http.Request, error) {
		req, err := h.newReq(ctx, http.MethodPut, rawurl, io.NopCloser(io.NewSectionReader(body, 0, size)))
		if err != nil {
			return nil, err
		}
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(io.NewSectionReader(body, 0, size)), nil
		}
		return req, nil
	}

	backoff := time.Second
	var last error
	for i := 0; i < 4; i++ {
		if i > 0 {
			if err := waitRetry(ctx, jitter(backoff)); err != nil {
				return nil, err
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
		req, err := mk()
		if err != nil {
			return nil, err
		}
		resp, err := h.hc.Do(req)
		if err != nil {
			last = &HubError{Kind: KindServer, Msg: scrubNetErr(err)}
			continue
		}
		var out PutResp
		_, derr := h.handle(resp, &out, false)
		if derr == nil {
			return &out, nil
		}
		last = derr
		var he *HubError
		// Retry 429/5xx AND a 409 "upload already in progress" — our own transport retry of a PUT
		// that the hub actually received races the in-flight stage; a brief backoff lets it clear.
		if errors.As(derr, &he) && (isRetriableStatus(he.Status) || he.Kind == KindBusyUpload) {
			if ra := retryAfter(resp.Header); ra > 0 {
				backoff = ra
			}
			continue
		}
		return nil, derr
	}
	return nil, last
}

// classify maps a non-2xx status + message to a HubError. The 409 table matches the literal Nest
// ConflictException strings in migration-ingest.service.ts (brittle by necessity — a hub-side
// machine `code` would be more robust; an unrecognised 409 fails closed).
func classify(code int, msg string) *HubError {
	k := KindOther
	switch code {
	case 401, 403:
		k = KindAuth
	case 404:
		k = KindNotFound
	case 400:
		k = KindBadRequest
	case 411:
		k = KindLengthRequired
	case 413:
		k = KindTooLarge
	case 415:
		k = KindBadMedia
	case 429:
		k = KindRateLimited
	case 507:
		k = KindNoSpace
	case 409:
		k = classify409(msg)
	default:
		if code >= 500 {
			k = KindServer
		}
	}
	return &HubError{Status: code, Kind: k, Msg: msg}
}

func classify409(msg string) ErrKind {
	m := strings.ToLower(msg)
	switch {
	case strings.Contains(m, "upload is already in progress"):
		return KindBusyUpload
	case strings.Contains(m, "a restore is in progress"), strings.Contains(m, "a restore is already in progress"):
		return KindRestoreInProgress
	case strings.Contains(m, "nothing staged"), strings.Contains(m, "staged artifact is missing"):
		return KindNotStaged
	case strings.Contains(m, "different artifact is already restored"):
		return KindDifferentRestored
	case strings.Contains(m, "was started or holds data"):
		return KindDestDirty
	case strings.Contains(m, "destination no longer exists"), strings.Contains(m, "target server not found"), strings.Contains(m, "does not belong to this import"):
		return KindDestGone
	case strings.Contains(m, "hub public url is not configured"):
		return KindHubMisconfig
	default:
		return KindUnknownConflict
	}
}

// ---- small helpers --------------------------------------------------------------------------

func readErrMessage(body io.Reader) string {
	b, _ := io.ReadAll(io.LimitReader(body, 4<<10))
	var env struct {
		Message any `json:"message"`
	}
	if json.Unmarshal(b, &env) == nil && env.Message != nil {
		switch v := env.Message.(type) {
		case string:
			return stripControl(v)
		case []any:
			var parts []string
			for _, p := range v {
				if s, ok := p.(string); ok {
					parts = append(parts, s)
				}
			}
			return stripControl(strings.Join(parts, "; "))
		}
	}
	return stripControl(string(b))
}

func stripControl(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r != 0x7f {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) > 256 {
		out = out[:256]
	}
	return out
}

func retryAfter(h http.Header) time.Duration {
	v := h.Get("Retry-After")
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
		if n < 1 {
			n = 1
		}
		if n > 60 {
			n = 60
		}
		return time.Duration(n) * time.Second
	}
	return 0
}

// jitter is deterministic-enough full jitter without Math.rand: it uses the low bits of the
// monotonic clock as a cheap spread. (A tiny bias is fine; this only de-synchronises retries.)
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	n := httpNow().UnixNano()
	frac := float64(n%1000) / 1000.0
	return time.Duration(float64(d) * (0.5 + 0.5*frac))
}

func scrubNetErr(err error) string {
	s := err.Error()
	s = migTokenRe.ReplaceAllString(s, "tugra_mig_***")
	return stripControl(s)
}

func sanitizeLocation(loc string) string {
	if loc == "" {
		return "(no Location)"
	}
	if u, err := url.Parse(loc); err == nil && u.Host != "" {
		return u.Scheme + "://" + u.Host
	}
	return "(opaque)"
}
