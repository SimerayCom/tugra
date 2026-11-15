package drains

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

func protoCfg(endpoint, egress string) protocol.DrainCfg {
	return protocol.DrainCfg{ID: "d", Type: "http", Endpoint: endpoint, Egress: egress}
}

var fixedTS = time.Date(2026, 11, 15, 10, 0, 0, 123456789, time.UTC)

func TestFormatSyslog5424Golden(t *testing.T) {
	o := syslogOpts{facility: 16}
	l := LogLine{Container: "tugra_a-web-1", Message: "hello", Stream: "stdout", TS: fixedTS}
	// PRI = 16*8 + 6 (info) = 134; TS at microsecond precision (RFC 5424 allows 6 fraction digits at most)
	if got := string(formatSyslog5424(o, "srv", l, time.Time{})); got != "<134>1 2026-11-15T10:00:00.123456Z srv tugra_a-web-1 - stdout - hello" {
		t.Fatalf("stdout record:\n%s", got)
	}
	// stderr = severity 3 -> PRI 131; app-name option overrides the container
	l.Stream = "stderr"
	o.appName = "myapp"
	if got := string(formatSyslog5424(o, "srv", l, time.Time{})); got != "<131>1 2026-11-15T10:00:00.123456Z srv myapp - stderr - hello" {
		t.Fatalf("stderr record:\n%s", got)
	}
	// facility math: local7 = 23 -> 23*8+6 = 190 ; kern = 0 -> 6
	if got := string(formatSyslog5424(syslogOpts{facility: 23}, "h", LogLine{Container: "c", Stream: "stdout", TS: fixedTS}, time.Time{})); !strings.HasPrefix(got, "<190>1 ") {
		t.Fatalf("facility 23: %s", got)
	}
	if got := string(formatSyslog5424(syslogOpts{facility: 0}, "h", LogLine{Container: "c", Stream: "stdout", TS: fixedTS}, time.Time{})); !strings.HasPrefix(got, "<6>1 ") {
		t.Fatalf("facility 0: %s", got)
	}
	// no docker TS -> the flush time; no stream -> NILVALUE msgid; empty message allowed
	flush := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	if got := string(formatSyslog5424(syslogOpts{facility: 16}, "h", LogLine{Container: "c"}, flush)); got != "<134>1 2030-01-02T03:04:05Z h c - - - " {
		t.Fatalf("flush-time record: %q", got)
	}
}

func TestSyslogSanitisation(t *testing.T) {
	o := syslogOpts{facility: 16}
	// newlines and control chars in the MSG never split a record
	got := string(formatSyslog5424(o, "srv", LogLine{Container: "c", Stream: "stdout", TS: fixedTS, Message: "a\nb\r\tc\x1b[0m\x00"}, time.Time{}))
	if strings.ContainsAny(got, "\n\r\t\x1b\x00") || !strings.HasSuffix(got, "a b  c [0m ") {
		t.Fatalf("control chars not replaced: %q", got)
	}
	// host / app are printable ASCII 33..126; spaces and non-ASCII become '_'; empty = "-"
	rec := string(formatSyslog5424(o, "my host é", LogLine{Container: "tugra a/b", Stream: "stdout", TS: fixedTS}, time.Time{}))
	if !strings.Contains(rec, " my_host___ tugra_a/b - stdout - ") {
		t.Fatalf("host/app sanitisation: %q", rec)
	}
	if !strings.Contains(string(formatSyslog5424(o, "", LogLine{Container: "", Stream: "stdout", TS: fixedTS}, time.Time{})), "Z - - - stdout - ") {
		t.Fatal("empty host/app must be the NILVALUE")
	}
	// caps: host <= 255, app <= 48
	rec = string(formatSyslog5424(o, strings.Repeat("h", 400), LogLine{Container: strings.Repeat("a", 100), Stream: "stdout", TS: fixedTS}, time.Time{}))
	parts := strings.SplitN(rec, " ", 6)
	if len(parts[2]) != 255 || len(parts[3]) != 48 {
		t.Fatalf("host/app caps: %d %d", len(parts[2]), len(parts[3]))
	}
	// invalid UTF-8 is repaired
	if got := string(formatSyslog5424(o, "h", LogLine{Container: "c", Message: "bad\xff", TS: fixedTS}, time.Time{})); !utf8.ValidString(got) {
		t.Fatal("invalid UTF-8 must be repaired")
	}
}

func TestSyslogUDPTruncation(t *testing.T) {
	o := syslogOpts{facility: 16}
	rec, truncated := buildSyslog(o, "srv", LogLine{Container: "c", Stream: "stdout", TS: fixedTS, Message: strings.Repeat("x", 5000)}, time.Time{}, syslogUDPMax)
	if !truncated || len(rec) != syslogUDPMax {
		t.Fatalf("udp record: truncated=%v len=%d", truncated, len(rec))
	}
	// truncation never splits a multi-byte rune
	rec, _ = buildSyslog(o, "srv", LogLine{Container: "c", Stream: "stdout", TS: fixedTS, Message: strings.Repeat("é", 2000)}, time.Time{}, syslogUDPMax)
	if !utf8.Valid(rec) || len(rec) > syslogUDPMax {
		t.Fatalf("rune-safe truncation failed: valid=%v len=%d", utf8.Valid(rec), len(rec))
	}
	if _, tr := buildSyslog(o, "srv", LogLine{Container: "c", Stream: "stdout", TS: fixedTS, Message: "short"}, time.Time{}, syslogUDPMax); tr {
		t.Fatal("a short record must not be truncated")
	}
}

func TestFrameSyslog(t *testing.T) {
	if got := string(frameSyslog("octet", []byte("abc"))); got != "3 abc" {
		t.Fatalf("octet framing: %q", got)
	}
	if got := string(frameSyslog("octet", []byte(strings.Repeat("é", 5)))); got != "10 "+strings.Repeat("é", 5) { // length in BYTES
		t.Fatalf("octet framing counts bytes: %q", got)
	}
	if got := string(frameSyslog("newline", []byte("abc"))); got != "abc\n" {
		t.Fatalf("newline framing: %q", got)
	}
}

func TestNewSyslogSenderValidation(t *testing.T) {
	bad := []protocol.DrainCfg{
		{Type: "syslog", Endpoint: "h:514"}, // options required
		{Type: "syslog", Endpoint: "h:514", Options: &protocol.DrainOptions{Proto: "sctp"}},
		{Type: "syslog", Endpoint: "h", Options: &protocol.DrainOptions{Proto: "udp"}},
		{Type: "syslog", Endpoint: "h:0", Options: &protocol.DrainOptions{Proto: "udp"}},
		{Type: "syslog", Endpoint: "h:514", Options: &protocol.DrainOptions{Proto: "tcp", Framing: "bogus"}},
		{Type: "syslog", Endpoint: "h:514", Options: &protocol.DrainOptions{Proto: "udp", Facility: intp(24)}},
		{Type: "syslog", Endpoint: "h:514", Options: &protocol.DrainOptions{Proto: "tls", CACert: "not a pem"}},
	}
	for i, c := range bad {
		if _, err := newSyslogSender(c); err == nil {
			t.Errorf("case %d should be invalid: %+v", i, c)
		}
	}
	if _, err := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: "[::1]:514", Options: &protocol.DrainOptions{Proto: "udp"}}); err != nil {
		t.Fatalf("a bracketed v6 endpoint is valid: %v", err)
	}
}

func intp(n int) *int { return &n }

// ---- round trips ----

// tcpCollector accepts connections on l and records, per connection, everything it reads until close.
type tcpCollector struct {
	l       net.Listener
	mu      sync.Mutex
	conns   [][]byte
	accepts atomic.Int32
	onConn  func(c net.Conn) // optional: take over a connection (return when done)
}

func newTCPCollector(t *testing.T, l net.Listener) *tcpCollector {
	t.Helper()
	tc := &tcpCollector{l: l}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			idx := int(tc.accepts.Add(1)) - 1
			tc.mu.Lock()
			tc.conns = append(tc.conns, nil)
			tc.mu.Unlock()
			go func() {
				defer c.Close()
				if tc.onConn != nil {
					tc.onConn(c)
					return
				}
				buf := make([]byte, 4096)
				for {
					n, err := c.Read(buf)
					if n > 0 {
						tc.mu.Lock()
						tc.conns[idx] = append(tc.conns[idx], buf[:n]...)
						tc.mu.Unlock()
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	return tc
}

func (tc *tcpCollector) data(i int) string {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if i >= len(tc.conns) {
		return ""
	}
	return string(tc.conns[i])
}

func TestSyslogTCPRoundTrip(t *testing.T) {
	l, addr := listenLoopback(t)
	tc := newTCPCollector(t, l)
	s, err := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: addr, Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "tcp"}}) // framing defaults to newline for tcp
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lines := []LogLine{{Container: "c1", Message: "one", Stream: "stdout", TS: fixedTS}, {Container: "c2", Message: "two", Stream: "stderr", TS: fixedTS}}
	if err := s.Send(context.Background(), lines); err != nil {
		t.Fatal(err)
	}
	want := "<134>1 2026-11-15T10:00:00.123456Z srv c1 - stdout - one\n<131>1 2026-11-15T10:00:00.123456Z srv c2 - stderr - two\n"
	waitFor(t, "tcp bytes", func() bool { return tc.data(0) == want })
	// the same connection is reused for the next batch
	if err := s.Send(context.Background(), lines[:1]); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "second batch on the same conn", func() bool { return strings.HasSuffix(tc.data(0), "- one\n") && len(tc.data(0)) > len(want) })
	if tc.accepts.Load() != 1 {
		t.Fatalf("connection must be reused, accepts=%d", tc.accepts.Load())
	}
}

func TestSyslogTCPRedialsAfterServerClose(t *testing.T) {
	l, addr := listenLoopback(t)
	var accepts atomic.Int32
	got := make(chan string, 4)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			n := accepts.Add(1)
			go func() {
				defer c.Close()
				buf := make([]byte, 4096)
				k, _ := c.Read(buf)
				got <- string(buf[:k])
				if n == 1 {
					return // the server closes the first connection right after the first batch
				}
				_, _ = io.Copy(io.Discard, c)
			}()
		}
	}()
	s, _ := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: addr, Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "tcp", Framing: "octet"}})
	defer s.Close()
	one := []LogLine{{Container: "c", Message: "m1", Stream: "stdout", TS: fixedTS}}
	if err := s.Send(context.Background(), one); err != nil {
		t.Fatal(err)
	}
	if first := <-got; !strings.Contains(first, "m1") {
		t.Fatalf("first batch: %q", first)
	}
	time.Sleep(150 * time.Millisecond) // let the FIN reach the client
	if err := s.Send(context.Background(), one); err != nil {
		t.Fatalf("send after the server closed the connection must redial: %v", err)
	}
	select {
	case second := <-got:
		if !strings.Contains(second, "m1") {
			t.Fatalf("second batch: %q", second)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the redialled connection never received the batch")
	}
	if accepts.Load() != 2 {
		t.Fatalf("expected exactly one redial, accepts=%d", accepts.Load())
	}
}

func TestSyslogUDPRoundTrip(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	s, err := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: pc.LocalAddr().String(), Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "udp", Facility: intp(1)}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Send(context.Background(), []LogLine{{Container: "c", Message: "one", Stream: "stdout", TS: fixedTS}, {Container: "c", Message: strings.Repeat("y", 4000), Stream: "stdout", TS: fixedTS}}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 65535)
	_ = pc.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, _, err := pc.ReadFrom(buf)
	if err != nil || string(buf[:n]) != "<14>1 2026-11-15T10:00:00.123456Z srv c - stdout - one" { // facility 1: 8+6
		t.Fatalf("datagram 1: %q %v", buf[:n], err)
	}
	n, _, err = pc.ReadFrom(buf)
	if err != nil || n != syslogUDPMax {
		t.Fatalf("datagram 2 must be truncated to %d, got %d (%v)", syslogUDPMax, n, err)
	}
	if s.(*syslogSender).truncated.Load() != 1 {
		t.Fatal("the truncation must be counted")
	}
}

// ---- TLS ----

type testPKI struct {
	certPEM string
	cert    tls.Certificate
}

func newTestPKI(t *testing.T) testPKI {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "tugra-test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true,
		DNSNames: []string{"localhost", "logs.internal"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return testPKI{
		certPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		cert:    tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
	}
}

func listenTLS(t *testing.T, pki testPKI) (net.Listener, string) {
	t.Helper()
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{pki.cert}, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	return l, l.Addr().String()
}

func TestSyslogTLSWithCACert(t *testing.T) {
	pki := newTestPKI(t)
	l, addr := listenTLS(t, pki)
	tc := newTCPCollector(t, l)
	s, err := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: addr, Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "tls", CACert: pki.certPEM}}) // framing defaults to octet for tls
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Send(context.Background(), []LogLine{{Container: "c", Message: "secure", Stream: "stdout", TS: fixedTS}}); err != nil {
		t.Fatalf("tls send with the caCert: %v", err)
	}
	rec := "<134>1 2026-11-15T10:00:00.123456Z srv c - stdout - secure"
	waitFor(t, "tls data", func() bool { return tc.data(0) == strconv.Itoa(len(rec))+" "+rec })
}

func TestSyslogTLSUnknownCAIsPermanentWithoutRetry(t *testing.T) {
	pki := newTestPKI(t)
	l, addr := listenTLS(t, pki)
	var accepted atomic.Int32
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() { _ = c.(*tls.Conn).Handshake(); c.Close() }()
		}
	}()
	defer l.Close()
	s, _ := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: addr, Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "tls"}}) // no caCert: the self-signed cert is untrusted
	defer s.Close()
	start := time.Now()
	err := s.Send(context.Background(), []LogLine{{Container: "c", Message: "x", TS: fixedTS}})
	de := classifyErr(err)
	if de == nil || de.class != errTLS || !de.permanent {
		t.Fatalf("unknown CA must be a permanent tls error, got %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("a permanent failure must not burn the retry backoff")
	}
	time.Sleep(100 * time.Millisecond)
	if accepted.Load() != 1 {
		t.Fatalf("a permanent TLS failure must not be retried (accepted %d connections)", accepted.Load())
	}
}

func TestSyslogTLSWrongServerNameFails(t *testing.T) {
	pki := newTestPKI(t)
	l, addr := listenTLS(t, pki)
	newTCPCollector(t, l)
	s, _ := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: addr, Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "tls", CACert: pki.certPEM, ServerName: "evil.example"}})
	defer s.Close()
	if err := s.Send(context.Background(), batchOf("x")); classifyErr(err) == nil || classifyErr(err).class != errTLS {
		t.Fatalf("server name mismatch must fail verification, got %v", err)
	}
	// and the right name passes
	s2, _ := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: addr, Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "tls", CACert: pki.certPEM, ServerName: "logs.internal"}})
	defer s2.Close()
	if err := s2.Send(context.Background(), batchOf("x")); err != nil {
		t.Fatalf("matching serverName must verify: %v", err)
	}
}

func TestSyslogPolicyBlocksLoopbackWhenPublic(t *testing.T) {
	_, addr := listenLoopback(t)
	s, _ := newSyslogSender(protocol.DrainCfg{Type: "syslog", Endpoint: addr, Egress: egressPublic, Options: &protocol.DrainOptions{Proto: "tcp"}})
	defer s.Close()
	err := s.Send(context.Background(), batchOf("x"))
	if de := classifyErr(err); de == nil || de.class != errPolicy || !de.permanent {
		t.Fatalf("public egress must refuse loopback permanently, got %v", err)
	}
}
