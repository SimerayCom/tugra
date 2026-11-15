package drains

import (
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	syslogUDPMax    = 1400     // one datagram per line, kept under a typical path MTU
	syslogStreamMax = 64 << 10 // TCP/TLS cap per message
	syslogFacility  = 16       // local0
)

// syslogOpts is the validated option set of a syslog drain.
type syslogOpts struct {
	proto    string // udp | tcp | tls
	facility int
	framing  string // octet | newline (tcp/tls)
	appName  string
}

// printable maps s to printable ASCII 33..126 (RFC 5424 PRINTUSASCII), replacing anything else with '_', and
// caps it at max bytes. An empty result is the NILVALUE "-".
func printable(s string, max int) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s) && len(b) < max; i++ {
		c := s[i]
		if c < 33 || c > 126 {
			c = '_'
		}
		b = append(b, c)
	}
	if len(b) == 0 {
		return "-"
	}
	return string(b)
}

// cleanMsg replaces control characters (including CR/LF, so one line is always one record) with a space and
// repairs invalid UTF-8.
func cleanMsg(m string) string {
	m = strings.ToValidUTF8(m, "�")
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, m)
}

// buildSyslog renders one RFC 5424 record: <PRI>1 TS HOST APP - MSGID - MSG (PROCID and STRUCTURED-DATA are the
// NILVALUE). PRI = facility*8 + severity (stderr = 3 "err", everything else = 6 "info"). TS is the docker
// timestamp (UTC) or the flush time, at microsecond precision (RFC 5424 allows at most 6 fractional digits). When
// max > 0 and the record is longer, the MSG is truncated (on a rune boundary) and truncated is reported.
func buildSyslog(o syslogOpts, host string, l LogLine, flush time.Time, max int) (rec []byte, truncated bool) {
	sev := 6
	if l.Stream == "stderr" {
		sev = 3
	}
	ts := l.TS
	if ts.IsZero() {
		ts = flush
	}
	app := o.appName
	if app == "" {
		app = l.Container
	}
	msgid := l.Stream
	var b []byte
	b = append(b, '<')
	b = strconv.AppendInt(b, int64(o.facility*8+sev), 10)
	b = append(b, '>', '1', ' ')
	b = append(b, ts.UTC().Format("2006-01-02T15:04:05.999999Z07:00")...)
	b = append(b, ' ')
	b = append(b, printable(host, 255)...)
	b = append(b, ' ')
	b = append(b, printable(app, 48)...)
	b = append(b, " - "...)
	b = append(b, printable(msgid, 32)...)
	b = append(b, " - "...)
	msg := []byte(cleanMsg(l.Message))
	if max > 0 && len(b)+len(msg) > max {
		room := max - len(b)
		if room < 0 {
			room = 0
		}
		cut := room
		for cut > 0 && cut < len(msg) && !utf8.RuneStart(msg[cut]) {
			cut--
		}
		msg = msg[:cut]
		truncated = true
	}
	return append(b, msg...), truncated
}

// formatSyslog5424 is buildSyslog without a length cap.
func formatSyslog5424(o syslogOpts, host string, l LogLine, flush time.Time) []byte {
	b, _ := buildSyslog(o, host, l, flush, 0)
	return b
}

// frameSyslog applies the stream framing: octet-counting "<len> <msg>" (RFC 6587) or newline-terminated.
func frameSyslog(framing string, msg []byte) []byte {
	if framing == "octet" {
		out := make([]byte, 0, len(msg)+8)
		out = strconv.AppendInt(out, int64(len(msg)), 10)
		out = append(out, ' ')
		return append(out, msg...)
	}
	out := make([]byte, 0, len(msg)+1)
	out = append(out, msg...)
	return append(out, '\n')
}

type syslogSender struct {
	cs        *connSender
	host      string
	o         syslogOpts
	now       func() time.Time
	truncated atomic.Int64
}

func newSyslogSender(cfg protocol.DrainCfg) (Sender, error) {
	opt := cfg.Options
	if opt == nil {
		return nil, errors.New("syslog options required")
	}
	o := syslogOpts{proto: opt.Proto, facility: syslogFacility, framing: opt.Framing, appName: opt.AppName}
	switch o.proto {
	case "udp", "tcp", "tls":
	default:
		return nil, errors.New("bad syslog proto")
	}
	if opt.Facility != nil {
		if *opt.Facility < 0 || *opt.Facility > 23 {
			return nil, errors.New("bad facility")
		}
		o.facility = *opt.Facility
	}
	if o.framing == "" {
		if o.proto == "tls" {
			o.framing = "octet"
		} else {
			o.framing = "newline"
		}
	}
	if o.framing != "octet" && o.framing != "newline" {
		return nil, errors.New("bad framing")
	}
	host, port, err := parseEndpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	var tc *connSender
	if o.proto == "tls" {
		tlsCfg, err := buildTLS(opt, host)
		if err != nil {
			return nil, err
		}
		tc = newConnSender("tls", host, port, cfg.Egress, tlsCfg)
	} else {
		tc = newConnSender(o.proto, host, port, cfg.Egress, nil)
	}
	return &syslogSender{cs: tc, host: cfg.Host, o: o, now: time.Now}, nil
}

func (s *syslogSender) Send(ctx context.Context, lines []LogLine) error {
	flush := s.now()
	if s.o.proto == "udp" {
		dgrams := make([][]byte, 0, len(lines))
		for _, l := range lines {
			rec, tr := buildSyslog(s.o, s.host, l, flush, syslogUDPMax)
			if tr {
				s.truncated.Add(1)
			}
			dgrams = append(dgrams, rec)
		}
		return s.cs.sendDatagrams(ctx, dgrams)
	}
	frames := make([][]byte, 0, len(lines))
	for _, l := range lines {
		rec, tr := buildSyslog(s.o, s.host, l, flush, syslogStreamMax)
		if tr {
			s.truncated.Add(1)
		}
		frames = append(frames, frameSyslog(s.o.framing, rec))
	}
	return s.cs.sendStream(ctx, func(c net.Conn) error {
		bufs := net.Buffers(append([][]byte(nil), frames...)) // WriteTo consumes the slice: rebuild per attempt
		_, err := bufs.WriteTo(c)
		return err
	})
}

// takeLoss implements lossReporter: records cut to the transport cap (still delivered) since the last call.
func (s *syslogSender) takeLoss() (dropped, truncated int64) { return 0, s.truncated.Swap(0) }

func (s *syslogSender) Close() { s.cs.Close() }
