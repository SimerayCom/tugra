package drains

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// fluentd Forward protocol (clean-room from the public spec, fluent/fluentd docs "Forward Protocol
// Specification v1"): MessagePack over TCP (optionally TLS) to fluentd / fluent-bit / Vector's default input on
// 24224. We send Forward Mode messages `[tag, [[EventTime, record], ...], {"chunk": <id>}]`, one per container;
// with requireAck the server answers `{"ack": <id>}` and an unacked chunk is retried (at-least-once). When a
// shared key is configured, the HELO / PING / PONG handshake authenticates both sides.
const forwardMaxTag = 128

// Overridable in tests (production values: 5 s each).
var (
	ackTimeout       = 5 * time.Second
	handshakeTimeout = 5 * time.Second
)

type fluentSender struct {
	cs         *connSender
	tag        string
	requireAck bool
	host       string
	appID      string
	key        string // shared key (the drain token); "" = no handshake
	now        func() time.Time

	mu    sync.Mutex // guards br (one reader per live connection)
	br    *bufio.Reader
	brFor net.Conn
}

func newFluentSender(cfg protocol.DrainCfg) (Sender, error) {
	opt := cfg.Options
	if opt == nil {
		return nil, errors.New("fluentd options required")
	}
	if opt.Proto != "tcp" && opt.Proto != "tls" {
		return nil, errors.New("bad fluentd proto")
	}
	host, port, err := parseEndpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	tag := opt.Tag
	if tag == "" {
		tag = "tugra"
	}
	ack := true
	if opt.RequireAck != nil {
		ack = *opt.RequireAck
	}
	var cs *connSender
	if opt.Proto == "tls" {
		tlsCfg, err := buildTLS(opt, host)
		if err != nil {
			return nil, err
		}
		cs = newConnSender("tls", host, port, cfg.Egress, tlsCfg)
	} else {
		cs = newConnSender("tcp", host, port, cfg.Egress, nil)
	}
	f := &fluentSender{cs: cs, tag: tag, requireAck: ack, host: cfg.Host, appID: cfg.AppID, key: cfg.Token, now: time.Now}
	if f.host == "" {
		f.host = "tugra"
	}
	if f.key != "" {
		cs.hello = f.handshake
	}
	return f, nil
}

func (f *fluentSender) reader(c net.Conn) *bufio.Reader {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.brFor != c {
		f.br, f.brFor = bufio.NewReader(c), c
	}
	return f.br
}

// sanitizeTagPart keeps [A-Za-z0-9_-] and maps anything else (dots included, so a name can't add tag levels) to '_'.
func sanitizeTagPart(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' {
			b = append(b, c)
		} else {
			b = append(b, '_')
		}
	}
	if len(b) == 0 {
		return "_"
	}
	return string(b)
}

// forwardTag is `<options.tag>.<sanitised container>`, capped at 128 bytes.
func forwardTag(prefix, container string) string {
	t := prefix + "." + sanitizeTagPart(container)
	if len(t) > forwardMaxTag {
		t = t[:forwardMaxTag]
	}
	return t
}

// encodeForward renders one Forward Mode message. requireAck adds the {"chunk": id} option; otherwise the option
// map is empty. Record keys: container, message, stream, source, host and (app scope) app_id.
func encodeForward(tag string, lines []LogLine, flush time.Time, host, appID, chunk string) []byte {
	var e mpEnc
	e.arrayHeader(3)
	e.str(tag)
	e.arrayHeader(len(lines))
	for _, l := range lines {
		ts := l.TS
		if ts.IsZero() {
			ts = flush
		}
		e.arrayHeader(2)
		e.eventTime(ts)
		n := 5
		if appID != "" {
			n = 6
		}
		e.mapHeader(n)
		e.str("container")
		e.str(l.Container)
		e.str("message")
		e.str(l.Message)
		e.str("stream")
		e.str(l.Stream)
		e.str("source")
		e.str("tugra")
		e.str("host")
		e.str(host)
		if appID != "" {
			e.str("app_id")
			e.str(appID)
		}
	}
	if chunk == "" {
		e.mapHeader(0)
	} else {
		e.mapHeader(1)
		e.str("chunk")
		e.str(chunk)
	}
	return e.b
}

// readAck waits (until the connection's read deadline) for one `{"ack": chunk}` reply.
func readAck(r *bufio.Reader, chunk string) error {
	v, err := mpDecode(r)
	if err != nil {
		return err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return newDrainErr(errAck, false, errors.New("ack is not a map"))
	}
	got, ok := m["ack"].(string)
	if !ok || got != chunk {
		return newDrainErr(errAck, false, errors.New("ack mismatch"))
	}
	return nil
}

func newChunkID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return base64.StdEncoding.EncodeToString(b[:])
}

func (f *fluentSender) Send(ctx context.Context, lines []LogLine) error {
	// Group per container, preserving first-seen order: one Forward message (own tag + chunk id) per container.
	var order []string
	groups := map[string][]LogLine{}
	for _, l := range lines {
		if _, ok := groups[l.Container]; !ok {
			order = append(order, l.Container)
		}
		groups[l.Container] = append(groups[l.Container], l)
	}
	flush := f.now()
	type msg struct {
		bytes []byte
		chunk string
	}
	msgs := make([]msg, 0, len(order))
	for _, c := range order {
		chunk := ""
		if f.requireAck {
			chunk = newChunkID()
		}
		msgs = append(msgs, msg{encodeForward(forwardTag(f.tag, c), groups[c], flush, f.host, f.appID, chunk), chunk})
	}
	return f.cs.sendStream(ctx, func(c net.Conn) error {
		bufs := make(net.Buffers, 0, len(msgs))
		for _, m := range msgs {
			bufs = append(bufs, m.bytes)
		}
		if _, err := bufs.WriteTo(c); err != nil {
			return err
		}
		if !f.requireAck {
			return nil
		}
		br := f.reader(c)
		for _, m := range msgs {
			_ = c.SetReadDeadline(time.Now().Add(ackTimeout))
			if err := readAck(br, m.chunk); err != nil {
				var de *drainErr
				if errors.As(err, &de) {
					return err
				}
				// a read timeout / closed connection while waiting for the ack: retriable, class "ack"
				return newDrainErr(errAck, false, err)
			}
		}
		_ = c.SetReadDeadline(time.Time{})
		return nil
	})
}

func (f *fluentSender) Close() { f.cs.Close() }

func sha512Hex(parts ...[]byte) string {
	h := sha512.New()
	for _, p := range parts {
		h.Write(p)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func asBytes(v any) ([]byte, bool) {
	switch x := v.(type) {
	case []byte:
		return x, true
	case string:
		return []byte(x), true
	}
	return nil, false
}

// handshake runs the shared-key authentication right after the connection is established:
//
//	server -> client: ["HELO", {"nonce": <bin>, "auth": <bin>, "keepalive": <bool>}]
//	client -> server: ["PING", hostname, salt, sha512hex(salt + hostname + nonce + key), username, password_digest]
//	server -> client: ["PONG", ok(bool), reason, server_hostname, sha512hex(salt + server_hostname + nonce + key)]
//
// The PONG digest is verified (constant time) so a server that does not know the key cannot pose as the sink. A
// server that sends no HELO (no <security> block) while a key is configured, a rejected PING or a bad PONG digest
// is a permanent failure: nothing is ever shipped to a sink that did not prove the shared key.
func (f *fluentSender) handshake(ctx context.Context, c net.Conn) error {
	br := f.reader(c)
	_ = c.SetDeadline(time.Now().Add(handshakeTimeout))
	defer func() { _ = c.SetDeadline(time.Time{}) }()

	v, err := mpDecode(br)
	if err != nil {
		return newDrainErr(errConfig, true, err) // no HELO: server not configured for auth (or not fluentd)
	}
	helo, ok := v.([]any)
	if !ok || len(helo) < 2 {
		return newDrainErr(errConfig, true, errors.New("bad HELO"))
	}
	if tag, _ := helo[0].(string); tag != "HELO" {
		return newDrainErr(errConfig, true, errors.New("expected HELO"))
	}
	opts, ok := helo[1].(map[string]any)
	if !ok {
		return newDrainErr(errConfig, true, errors.New("bad HELO options"))
	}
	nonce, _ := asBytes(opts["nonce"])

	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return newDrainErr(errConfig, true, err)
	}
	var e mpEnc
	e.arrayHeader(6)
	e.str("PING")
	e.str(f.host)
	e.bin(salt)
	e.str(sha512Hex(salt, []byte(f.host), nonce, []byte(f.key)))
	e.str("") // no user authentication: username + password digest are empty
	e.str("")
	if _, err := c.Write(e.b); err != nil {
		return err
	}

	v, err = mpDecode(br)
	if err != nil {
		return newDrainErr(errConfig, true, err)
	}
	pong, ok := v.([]any)
	if !ok || len(pong) < 5 {
		return newDrainErr(errConfig, true, errors.New("bad PONG"))
	}
	if tag, _ := pong[0].(string); tag != "PONG" {
		return newDrainErr(errConfig, true, errors.New("expected PONG"))
	}
	if okv, _ := pong[1].(bool); !okv {
		return newDrainErr(errConfig, true, errors.New("server rejected the shared key"))
	}
	srvHost, _ := asBytes(pong[3])
	srvDigest, _ := pong[4].(string)
	want := sha512Hex(salt, srvHost, nonce, []byte(f.key))
	if subtle.ConstantTimeCompare([]byte(want), []byte(srvDigest)) != 1 {
		return newDrainErr(errTLS, true, errors.New("PONG digest mismatch"))
	}
	return nil
}
