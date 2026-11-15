package drains

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	dialTimeout  = 5 * time.Second
	writeTimeout = 10 * time.Second
	// maxConnAge forces a redial now and then so a hostname that moved is re-resolved (UDP in particular holds
	// no real connection and would otherwise keep sending to the old address forever).
	maxConnAge = 10 * time.Minute
)

var errSenderClosed = newDrainErr(errWrite, true, errors.New("sender closed"))

// parseEndpoint splits "host:port" / "[v6]:port" / "ipv4:port" (no scheme, no path).
func parseEndpoint(ep string) (host, port string, err error) {
	host, port, err = net.SplitHostPort(ep)
	if err != nil || host == "" {
		return "", "", errors.New("bad endpoint")
	}
	n, perr := strconv.Atoi(port)
	if perr != nil || n < 1 || n > 65535 {
		return "", "", errors.New("bad port")
	}
	return host, port, nil
}

// buildTLS builds the client TLS config: TLS 1.2+, verification ALWAYS on (there is no insecure option),
// ServerName from the option or the endpoint host, roots = the system pool plus the optional caCert bundle.
func buildTLS(o *protocol.DrainOptions, endpointHost string) (*tls.Config, error) {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if o != nil && o.CACert != "" {
		if !pool.AppendCertsFromPEM([]byte(o.CACert)) {
			return nil, errors.New("bad caCert")
		}
	}
	name := endpointHost
	if o != nil && o.ServerName != "" {
		name = o.ServerName
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, ServerName: name, RootCAs: pool}, nil
}

// connSender owns one (re)dialable connection to a syslog/GELF/fluentd target. proto is "tcp", "udp" or "tls".
// Egress is enforced by the guarded dialer on the RESOLVED address of every dial.
type connSender struct {
	proto  string
	addr   string
	dialer *net.Dialer
	tlsCfg *tls.Config
	// hello runs once per fresh stream connection before the first write (fluentd shared-key handshake).
	hello func(ctx context.Context, c net.Conn) error

	mu       sync.Mutex
	conn     net.Conn
	dialedAt time.Time
	closed   bool
}

func newConnSender(proto, host, port, egress string, tlsCfg *tls.Config) *connSender {
	if egress == "" {
		egress = egressPublic // fail closed: a hub that omitted the policy must not open LAN/loopback egress
	}
	return &connSender{proto: proto, addr: net.JoinHostPort(host, port), dialer: guardedDialer(egress), tlsCfg: tlsCfg}
}

func (c *connSender) dial(ctx context.Context) (net.Conn, error) {
	switch c.proto {
	case "udp":
		return c.dialer.DialContext(ctx, "udp", c.addr)
	case "tls":
		d := &tls.Dialer{NetDialer: c.dialer, Config: c.tlsCfg}
		return d.DialContext(ctx, "tcp", c.addr)
	default:
		return c.dialer.DialContext(ctx, "tcp", c.addr)
	}
}

// connAlive probes an idle stream connection: a closed peer shows up as EOF on a (very short) read, so a stale
// connection is redialled BEFORE the write (TCP would otherwise happily accept one write into a dead socket).
// A past deadline would short-circuit before touching the socket, hence the 1 ms window.
func connAlive(conn net.Conn) bool {
	_ = conn.SetReadDeadline(time.Now().Add(time.Millisecond))
	var b [1]byte
	n, err := conn.Read(b[:])
	_ = conn.SetReadDeadline(time.Time{})
	if n > 0 {
		return false // unsolicited data: the stream is out of sync
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (c *connSender) get(ctx context.Context) (net.Conn, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errSenderClosed
	}
	if c.conn != nil {
		fresh := time.Since(c.dialedAt) < maxConnAge
		if fresh && (c.proto == "udp" || connAlive(c.conn)) {
			conn := c.conn
			c.mu.Unlock()
			return conn, nil
		}
		_ = c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()

	conn, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	if c.hello != nil && c.proto != "udp" {
		if err := c.hello(ctx, conn); err != nil {
			_ = conn.Close()
			return nil, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		_ = conn.Close()
		return nil, errSenderClosed
	}
	c.conn, c.dialedAt = conn, time.Now()
	return conn, nil
}

func (c *connSender) drop() {
	c.mu.Lock()
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()
}

func (c *connSender) Close() {
	c.mu.Lock()
	c.closed = true
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()
}

func deadlineFor(ctx context.Context, d time.Duration) time.Time {
	t := time.Now().Add(d)
	if dl, ok := ctx.Deadline(); ok && dl.Before(t) {
		return dl
	}
	return t
}

// sendStream runs write on a (re)dialled stream connection with retries: a network error, timeout or missing ack
// is retriable (the connection is dropped and redialled), a TLS verification / config / policy error is
// permanent. The whole batch shares batchSendBudget, with maxAttempts and attempt*300ms backoff.
func (c *connSender) sendStream(ctx context.Context, write func(net.Conn) error) error {
	bctx, cancel := context.WithTimeout(ctx, batchSendBudget)
	defer cancel()
	var last *drainErr
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-bctx.Done():
				return last
			case <-time.After(time.Duration(attempt) * 300 * time.Millisecond):
			}
		}
		conn, err := c.get(bctx)
		if err != nil {
			last = classifyErr(err)
			if last.permanent {
				return last
			}
			continue
		}
		_ = conn.SetWriteDeadline(deadlineFor(bctx, writeTimeout))
		if err := write(conn); err != nil {
			c.drop()
			last = classifyErr(err)
			if last.permanent {
				return last
			}
			continue
		}
		return nil
	}
	if last == nil {
		last = newDrainErr(errWrite, false, fmt.Errorf("no attempt made"))
	}
	return last
}

// sendDatagrams writes each datagram once: UDP has no ack, so there is no retry and only local errors (a refused
// ICMP, a policy block, a local write error) count.
func (c *connSender) sendDatagrams(ctx context.Context, dgrams [][]byte) error {
	conn, err := c.get(ctx)
	if err != nil {
		return classifyErr(err)
	}
	for _, d := range dgrams {
		_ = conn.SetWriteDeadline(deadlineFor(ctx, writeTimeout))
		if _, err := conn.Write(d); err != nil {
			c.drop()
			return classifyErr(err)
		}
	}
	return nil
}
