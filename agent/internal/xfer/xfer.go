// Package xfer moves file bodies between the agent and the hub over plain HTTP(S), outside the WebSocket.
// The hub hands the agent only a RELATIVE, HMAC-signed path; the agent builds the URL from its OWN configured hub
// origin (Origin), so the hub can never steer the agent to another host (no SSRF). The signed path is the only
// credential — no auth header is sent.
package xfer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/endpoints"
)

// pathRe is the ONLY shape of path the agent will request: the hub's transfer route plus its exp/sig query. A
// host, scheme, "..", extra parameter, fragment or CR/LF can never match.
var pathRe = regexp.MustCompile(`^/api/v1/agent-fs/t/[A-Za-z0-9_-]{16,64}\?exp=[0-9]{1,12}&sig=[A-Za-z0-9_-]{16,128}$`)

// ValidPath reports whether p is an acceptable signed transfer path.
func ValidPath(p string) bool { return pathRe.MatchString(p) }

// Origin derives the hub's HTTP origin from the agent's own configured hub URL: ws -> http, wss -> https, host
// and port kept, path/query/userinfo dropped.
func Origin(hubURL string) (string, error) {
	u, err := url.Parse(hubURL)
	if err != nil {
		return "", err
	}
	var scheme string
	switch strings.ToLower(u.Scheme) {
	case "ws", "http":
		scheme = "http"
	case "wss", "https":
		scheme = "https"
	default:
		return "", fmt.Errorf("unsupported hub URL scheme %q", u.Scheme)
	}
	if u.Hostname() == "" {
		return "", errors.New("hub URL has no host")
	}
	return scheme + "://" + u.Host, nil
}

// client refuses redirects (a signed URL must be answered where it points, never re-aimed), verifies TLS, and
// bounds the wait for response headers. There is deliberately no overall timeout: a body may legitimately take
// minutes, and the caller's context bounds the whole transfer.
var client = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport: func() http.RoundTripper {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.ResponseHeaderTimeout = 30 * time.Second
		// No transparent gzip: Go would add Accept-Encoding and decode, which hides Content-Length (-1) and would fail
		// the exact-length check below behind any proxy or CDN that compresses octet-streams.
		t.DisableCompression = true
		return t
	}(),
}

// pins maps a hub origin to the leaf-certificate pin its (self-signed) hub must present. Set by the client for the
// endpoint the session is on, so the relay verifies the same certificate the WebSocket does. Origins without a pin
// use the default client (system roots).
var (
	pinMu   sync.Mutex
	pins    = map[string]string{}
	pinHTTP = map[string]*http.Client{}
)

// SetPin pins (or, with an empty pin, unpins) the origin. Call it with the Origin() of the endpoint in use.
func SetPin(origin, pin string) {
	pinMu.Lock()
	defer pinMu.Unlock()
	if pin == "" {
		delete(pins, origin)
		return
	}
	pins[origin] = pin
	delete(pinHTTP, pin)
}

// clientFor returns the HTTP client for an origin: pinned when the origin has a pin, else the default.
func clientFor(origin string) *http.Client {
	pinMu.Lock()
	defer pinMu.Unlock()
	pin, ok := pins[origin]
	if !ok {
		return client
	}
	if c, ok := pinHTTP[pin]; ok {
		return c
	}
	c, err := endpoints.HTTPClient(pin, nil)
	if err != nil {
		return client // a malformed pin cannot be enforced: fall back to full chain verification (fails closed on self-signed)
	}
	c.Transport.(*http.Transport).DisableCompression = true
	pinHTTP[pin] = c
	return c
}

func build(ctx context.Context, method, origin, path string, body io.Reader) (*http.Request, error) {
	if !ValidPath(path) {
		return nil, errors.New("invalid transfer path")
	}
	return http.NewRequestWithContext(ctx, method, origin+path, body)
}

type limitedBody struct {
	io.Reader
	io.Closer
}

// Get opens the hub's staged body for a write. The response must be 200 with a Content-Length of exactly size;
// the returned reader yields at most size+1 bytes so the consumer's EOF check catches a server that lies.
func Get(ctx context.Context, origin, path string, size int64) (io.ReadCloser, error) {
	req, err := build(ctx, http.MethodGet, origin, path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := clientFor(origin).Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("transfer refused (HTTP %d)", resp.StatusCode)
	}
	if resp.ContentLength != size {
		_ = resp.Body.Close()
		return nil, errors.New("transfer length mismatch")
	}
	return limitedBody{Reader: io.LimitReader(resp.Body, size+1), Closer: resp.Body}, nil
}

// Put streams exactly size bytes of body to the hub (the download relay). ContentLength is set so the transport
// itself fails the request when the producer yields a different number of bytes.
func Put(ctx context.Context, origin, path string, body io.Reader, size int64) error {
	var rd io.Reader = body
	if size == 0 {
		rd = http.NoBody
	}
	req, err := build(ctx, http.MethodPut, origin, path, rd)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := clientFor(origin).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("transfer refused (HTTP %d)", resp.StatusCode)
	}
	return nil
}

// PutFrom runs produce (typically the sandboxed helper writing a file to w) and pipes what it writes to the hub
// as the body of a Put. If produce fails, the pipe is closed WITH its error, which aborts the in-flight request
// (the hub then fails the browser download instead of ending it cleanly) and cancels the context handed to produce
// so a still-running helper container is reaped. A producer error wins over the resulting transport error.
func PutFrom(ctx context.Context, origin, path string, size int64, produce func(ctx context.Context, w io.Writer) error) error {
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	prodErr := make(chan error, 1)
	go func() {
		err := produce(cctx, pw)
		if err != nil {
			cancel()
			_ = pw.CloseWithError(err)
		} else {
			_ = pw.Close()
		}
		prodErr <- err
	}()
	putErr := Put(cctx, origin, path, pr, size)
	if putErr != nil {
		// The transport gave up (hub error, abort): unblock a producer stuck writing into the pipe.
		cancel()
		_ = pr.CloseWithError(putErr)
	}
	perr := <-prodErr
	if perr != nil {
		return perr
	}
	return putErr
}
