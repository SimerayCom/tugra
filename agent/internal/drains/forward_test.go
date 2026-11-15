package drains

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

func TestEncodeForwardGolden(t *testing.T) {
	// [ "tugra.web", [ [EventTime(1s,2ns), {container,message,stream,source,host}] ], {"chunk": "AAAA"} ]
	// assembled by hand from the msgpack spec
	lines := []LogLine{{Container: "web", Message: "hi", Stream: "stdout", TS: time.Unix(1, 2)}}
	got := encodeForward("tugra.web", lines, time.Time{}, "srv", "", "AAAA")
	want := strings.Join([]string{
		"93", // array(3)
		"a9", hex.EncodeToString([]byte("tugra.web")),
		"91", // array(1): entries
		"92", // array(2): [time, record]
		"d7 00 00 00 00 01 00 00 00 02",
		"85", // map(5)
		"a9", hex.EncodeToString([]byte("container")), "a3", hex.EncodeToString([]byte("web")),
		"a7", hex.EncodeToString([]byte("message")), "a2", hex.EncodeToString([]byte("hi")),
		"a6", hex.EncodeToString([]byte("stream")), "a6", hex.EncodeToString([]byte("stdout")),
		"a6", hex.EncodeToString([]byte("source")), "a5", hex.EncodeToString([]byte("tugra")),
		"a4", hex.EncodeToString([]byte("host")), "a3", hex.EncodeToString([]byte("srv")),
		"81", // option map(1)
		"a5", hex.EncodeToString([]byte("chunk")), "a4", hex.EncodeToString([]byte("AAAA")),
	}, "")
	if !bytes.Equal(got, hx(t, want)) {
		t.Fatalf("forward bytes:\n got %x\nwant %s", got, strings.ReplaceAll(want, " ", ""))
	}
	// app scope adds app_id (map(6)); no ack -> empty option map
	got = encodeForward("t", lines, time.Time{}, "srv", "a1", "")
	if !bytes.Contains(got, hx(t, "86")) || !bytes.HasSuffix(got, hx(t, "a6"+hex.EncodeToString([]byte("app_id"))+"a2"+hex.EncodeToString([]byte("a1"))+"80")) {
		t.Fatalf("app_id / empty options: %x", got)
	}
	// the stream is decodable by our decoder as a 3-element array
	v, err := mpDecode(bufio.NewReader(bytes.NewReader(got)))
	if err != nil || len(v.([]any)) != 3 {
		t.Fatalf("decode: %v %v", v, err)
	}
}

func TestForwardTagSanitising(t *testing.T) {
	for in, want := range map[string]string{
		"tugra_a-web-1":  "tugra.tugra_a-web-1",
		"tugra_a.1.x9y8": "tugra.tugra_a_1_x9y8", // dots cannot add tag levels
		"weird name/é":   "tugra.weird_name___",  // é is 2 bytes
		"":               "tugra._",
	} {
		if got := forwardTag("tugra", in); got != want {
			t.Errorf("forwardTag(%q) = %q, want %q", in, got, want)
		}
	}
	if got := forwardTag("tugra", strings.Repeat("a", 300)); len(got) != forwardMaxTag {
		t.Fatalf("tag must be capped at %d, got %d", forwardMaxTag, len(got))
	}
}

// ---- fake fluentd ----

type fakeFluent struct {
	l       net.Listener
	conns   atomic.Int32
	msgs    chan []any // every decoded Forward message
	ackMode func(conn int, chunk string) (ack bool)
	key     string // when set: run the HELO/PING/PONG handshake first
	badPong bool   // reply PONG with a wrong digest
	noHelo  bool   // never send HELO (a server without <security>)
	reject  bool   // reply PONG ok=false
}

func startFakeFluent(t *testing.T, mut func(f *fakeFluent)) *fakeFluent {
	t.Helper()
	l, _ := listenLoopback(t)
	f := &fakeFluent{l: l, msgs: make(chan []any, 16), ackMode: func(int, string) bool { return true }}
	if mut != nil {
		mut(f)
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			n := int(f.conns.Add(1))
			go f.serve(c, n)
		}
	}()
	return f
}

func (f *fakeFluent) addr() string { return f.l.Addr().String() }

func (f *fakeFluent) serve(c net.Conn, n int) {
	defer c.Close()
	br := bufio.NewReader(c)
	if f.key != "" && !f.noHelo {
		nonce := []byte("nonce-0123456789")
		var e mpEnc
		e.arrayHeader(2)
		e.str("HELO")
		e.mapHeader(3)
		e.str("nonce")
		e.bin(nonce)
		e.str("auth")
		e.bin(nil)
		e.str("keepalive")
		e.bool_(true)
		_, _ = c.Write(e.b)
		v, err := mpDecode(br)
		if err != nil {
			return
		}
		ping := v.([]any)
		salt, _ := asBytes(ping[2])
		host, _ := ping[1].(string)
		wantDigest := sha512Hex(salt, []byte(host), nonce, []byte(f.key))
		clientDigest, _ := ping[3].(string)
		var pong mpEnc
		pong.arrayHeader(5)
		pong.str("PONG")
		if ping[0] != "PING" || clientDigest != wantDigest || f.reject {
			pong.bool_(false)
			pong.str("shared key mismatch")
			pong.str("fluentd-host")
			pong.str("")
			_, _ = c.Write(pong.b)
			return
		}
		pong.bool_(true)
		pong.str("")
		pong.str("fluentd-host")
		digest := sha512Hex(salt, []byte("fluentd-host"), nonce, []byte(f.key))
		if f.badPong {
			digest = strings.Repeat("0", 128)
		}
		pong.str(digest)
		_, _ = c.Write(pong.b)
	}
	for {
		v, err := mpDecode(br)
		if err != nil {
			return
		}
		msg, ok := v.([]any)
		if !ok || len(msg) < 3 {
			return
		}
		f.msgs <- msg
		opts, _ := msg[2].(map[string]any)
		chunk, _ := opts["chunk"].(string)
		if chunk != "" && f.ackMode(n, chunk) {
			var e mpEnc
			e.mapHeader(1)
			e.str("ack")
			e.str(chunk)
			_, _ = c.Write(e.b)
		}
	}
}

func fluentCfg(addr string, mut func(*protocol.DrainOptions), token string) protocol.DrainCfg {
	o := &protocol.DrainOptions{Proto: "tcp", Tag: "tugra"}
	if mut != nil {
		mut(o)
	}
	return protocol.DrainCfg{ID: "f", Type: "fluentd", Endpoint: addr, Host: "srv", Egress: egressAny, Token: token, Options: o}
}

func recvMsg(t *testing.T, f *fakeFluent) []any {
	t.Helper()
	select {
	case m := <-f.msgs:
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("fluentd received nothing")
		return nil
	}
}

func TestFluentdForwardWithAck(t *testing.T) {
	f := startFakeFluent(t, nil)
	s, err := newFluentSender(fluentCfg(f.addr(), nil, ""))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := time.Unix(1731664800, 5)
	err = s.Send(context.Background(), []LogLine{
		{Container: "tugra_a-web-1", Message: "one", Stream: "stdout", TS: ts},
		{Container: "tugra_a-db-1", Message: "db", Stream: "stderr", TS: ts},
		{Container: "tugra_a-web-1", Message: "two", Stream: "stdout", TS: ts},
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	// one Forward message per container, grouped, in first-seen order
	m1, m2 := recvMsg(t, f), recvMsg(t, f)
	if m1[0] != "tugra.tugra_a-web-1" || m2[0] != "tugra.tugra_a-db-1" {
		t.Fatalf("tags: %v %v", m1[0], m2[0])
	}
	entries := m1[1].([]any)
	if len(entries) != 2 {
		t.Fatalf("web entries: %d", len(entries))
	}
	rec := entries[0].([]any)[1].(map[string]any)
	if rec["message"] != "one" || rec["stream"] != "stdout" || rec["source"] != "tugra" || rec["host"] != "srv" || rec["container"] != "tugra_a-web-1" {
		t.Fatalf("record: %v", rec)
	}
	if ext := entries[0].([]any)[0].(mpExt); ext.Type != 0 || len(ext.Data) != 8 {
		t.Fatalf("EventTime ext: %+v", ext)
	}
	if _, ok := m1[2].(map[string]any)["chunk"].(string); !ok {
		t.Fatal("ack mode must carry a chunk id")
	}
}

func TestFluentdNoAckMode(t *testing.T) {
	f := startFakeFluent(t, func(f *fakeFluent) {
		f.ackMode = func(int, string) bool { t.Error("server must not be asked to ack"); return false }
	})
	no := false
	s, _ := newFluentSender(fluentCfg(f.addr(), func(o *protocol.DrainOptions) { o.RequireAck = &no }, ""))
	defer s.Close()
	if err := s.Send(context.Background(), batchOf("x")); err != nil {
		t.Fatal(err)
	}
	m := recvMsg(t, f)
	if len(m[2].(map[string]any)) != 0 {
		t.Fatalf("requireAck=false must send an empty option map, got %v", m[2])
	}
}

func TestFluentdAckTimeoutRetries(t *testing.T) {
	old := ackTimeout
	ackTimeout = 150 * time.Millisecond
	t.Cleanup(func() { ackTimeout = old })
	f := startFakeFluent(t, func(f *fakeFluent) { f.ackMode = func(conn int, _ string) bool { return conn >= 2 } }) // conn 1 never acks
	s, _ := newFluentSender(fluentCfg(f.addr(), nil, ""))
	defer s.Close()
	if err := s.Send(context.Background(), batchOf("x")); err != nil {
		t.Fatalf("an ack timeout is retriable and the redialled connection acks: %v", err)
	}
	if f.conns.Load() != 2 {
		t.Fatalf("expected a redial after the ack timeout, conns=%d", f.conns.Load())
	}
	recvMsg(t, f)
	recvMsg(t, f) // the batch arrived twice (at-least-once)
}

func TestFluentdAckNeverArrivesFailsWithAckClass(t *testing.T) {
	old := ackTimeout
	ackTimeout = 50 * time.Millisecond
	t.Cleanup(func() { ackTimeout = old })
	f := startFakeFluent(t, func(f *fakeFluent) { f.ackMode = func(int, string) bool { return false } })
	s, _ := newFluentSender(fluentCfg(f.addr(), nil, ""))
	defer s.Close()
	err := s.Send(context.Background(), batchOf("x"))
	if de := classifyErr(err); de == nil || de.class != errAck || de.permanent {
		t.Fatalf("a missing ack is a retriable 'ack' error, got %v", err)
	}
}

func TestReadAckMismatch(t *testing.T) {
	var e mpEnc
	e.mapHeader(1)
	e.str("ack")
	e.str("other")
	if err := readAck(bufio.NewReader(bytes.NewReader(e.b)), "mine"); classifyErr(err).class != errAck {
		t.Fatalf("mismatched ack: %v", err)
	}
	var ok mpEnc
	ok.mapHeader(1)
	ok.str("ack")
	ok.str("mine")
	if err := readAck(bufio.NewReader(bytes.NewReader(ok.b)), "mine"); err != nil {
		t.Fatalf("matching ack: %v", err)
	}
}

func TestFluentdSharedKeyHandshake(t *testing.T) {
	f := startFakeFluent(t, func(f *fakeFluent) { f.key = "s3cret" })
	s, _ := newFluentSender(fluentCfg(f.addr(), nil, "s3cret"))
	defer s.Close()
	if err := s.Send(context.Background(), batchOf("authed")); err != nil {
		t.Fatalf("handshake + send with the right key: %v", err)
	}
	if m := recvMsg(t, f); m[0] != "tugra.c" {
		t.Fatalf("message after handshake: %v", m)
	}
	// the PING digest matches the documented formula (re-derive independently from the wire in the fake above):
	// sha512hex(salt + hostname + nonce + key) — also assert the primitive itself against a known vector
	h := sha512.Sum512([]byte("abc"))
	if sha512Hex([]byte("a"), []byte("b"), []byte("c")) != hex.EncodeToString(h[:]) {
		t.Fatal("sha512Hex must hash the concatenation of its parts")
	}
}

func TestFluentdWrongKeyIsPermanentConfigError(t *testing.T) {
	f := startFakeFluent(t, func(f *fakeFluent) { f.key = "right" })
	s, _ := newFluentSender(fluentCfg(f.addr(), nil, "wrong"))
	defer s.Close()
	err := s.Send(context.Background(), batchOf("x"))
	if de := classifyErr(err); de == nil || de.class != errConfig || !de.permanent {
		t.Fatalf("a rejected shared key must be a permanent config error, got %v", err)
	}
	if f.conns.Load() != 1 {
		t.Fatalf("a permanent handshake failure must not be retried, conns=%d", f.conns.Load())
	}
	select {
	case m := <-f.msgs:
		t.Fatalf("nothing may be shipped after a failed handshake, got %v", m)
	default:
	}
}

func TestFluentdBadPongDigestIsRejected(t *testing.T) {
	f := startFakeFluent(t, func(f *fakeFluent) { f.key = "k"; f.badPong = true })
	s, _ := newFluentSender(fluentCfg(f.addr(), nil, "k"))
	defer s.Close()
	err := s.Send(context.Background(), batchOf("x"))
	if de := classifyErr(err); de == nil || de.class != errTLS || !de.permanent {
		t.Fatalf("a server that cannot prove the key must be refused (permanent), got %v", err)
	}
	select {
	case <-f.msgs:
		t.Fatal("logs were shipped to a sink that failed server authentication")
	default:
	}
}

func TestFluentdServerWithoutAuthWhileKeyConfigured(t *testing.T) {
	old := handshakeTimeout
	handshakeTimeout = 100 * time.Millisecond
	t.Cleanup(func() { handshakeTimeout = old })
	// a plain fluentd with no <security>: never sends HELO
	f := startFakeFluent(t, func(f *fakeFluent) { f.noHelo = true; f.key = "k" })
	s, _ := newFluentSender(fluentCfg(f.addr(), nil, "k"))
	defer s.Close()
	err := s.Send(context.Background(), batchOf("x"))
	if de := classifyErr(err); de == nil || de.class != errConfig || !de.permanent {
		t.Fatalf("PONG-less / HELO-less server with a key configured must fail permanently, got %v", err)
	}
	select {
	case <-f.msgs:
		t.Fatal("logs were shipped without authentication")
	default:
	}
}

func TestNewFluentSenderValidation(t *testing.T) {
	for i, c := range []protocol.DrainCfg{
		{Type: "fluentd", Endpoint: "h:24224"},
		{Type: "fluentd", Endpoint: "h:24224", Options: &protocol.DrainOptions{Proto: "udp"}},
		{Type: "fluentd", Endpoint: "h", Options: &protocol.DrainOptions{Proto: "tcp"}},
		{Type: "fluentd", Endpoint: "h:24224", Options: &protocol.DrainOptions{Proto: "tls", CACert: "x"}},
	} {
		if _, err := newFluentSender(c); err == nil {
			t.Errorf("case %d must be invalid", i)
		}
	}
	s, err := newFluentSender(protocol.DrainCfg{Type: "fluentd", Endpoint: "h:24224", Options: &protocol.DrainOptions{Proto: "tcp"}})
	if err != nil {
		t.Fatal(err)
	}
	fs := s.(*fluentSender)
	if fs.tag != "tugra" || !fs.requireAck {
		t.Fatalf("defaults: tag %q ack %v", fs.tag, fs.requireAck)
	}
}
