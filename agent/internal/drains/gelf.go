package drains

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/rand"
	"encoding/json"
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
	gelfMaxMessage = 64 << 10 // pre-cap of short_message
	gelfChunkMax   = 1420     // max UDP datagram size incl. the 12-byte chunk header
	gelfChunkHdr   = 12
	gelfMaxChunks  = 128
)

// gelfMsg is the GELF 1.1 payload. Field order is the marshal order (golden-tested). Timestamp is a json.Number
// so it renders with exactly six decimals and no float rounding.
type gelfMsg struct {
	Version      string      `json:"version"`
	Host         string      `json:"host"`
	ShortMessage string      `json:"short_message"`
	Timestamp    json.Number `json:"timestamp"`
	Level        int         `json:"level"`
	Container    string      `json:"_container"`
	Stream       string      `json:"_stream"`
	Source       string      `json:"_source"`
	AppID        string      `json:"_app_id,omitempty"`
}

func gelfTimestamp(t time.Time) json.Number {
	sec, us := t.Unix(), t.Nanosecond()/1000
	frac := strconv.Itoa(us)
	return json.Number(strconv.FormatInt(sec, 10) + "." + strings.Repeat("0", 6-len(frac)) + frac)
}

// buildGelf renders one GELF JSON message. short_message is never empty ("(empty)") and pre-capped at 64 KiB
// (on a rune boundary). level: 3 for stderr, 6 otherwise.
func buildGelf(host, appID string, l LogLine, flush time.Time) ([]byte, error) {
	ts := l.TS
	if ts.IsZero() {
		ts = flush
	}
	level := 6
	if l.Stream == "stderr" {
		level = 3
	}
	msg := strings.ToValidUTF8(l.Message, "�")
	if len(msg) > gelfMaxMessage {
		cut := gelfMaxMessage
		for cut > 0 && !utf8.RuneStart(msg[cut]) {
			cut--
		}
		msg = msg[:cut]
	}
	if msg == "" {
		msg = "(empty)"
	}
	if host == "" {
		host = "tugra"
	}
	return json.Marshal(gelfMsg{
		Version: "1.1", Host: host, ShortMessage: msg, Timestamp: gelfTimestamp(ts), Level: level,
		Container: l.Container, Stream: l.Stream, Source: "tugra", AppID: appID,
	})
}

// compressGelf applies the UDP compression ("none" | "gzip" | "zlib").
func compressGelf(mode string, b []byte) ([]byte, error) {
	var buf bytes.Buffer
	switch mode {
	case "gzip":
		w := gzip.NewWriter(&buf)
		if _, err := w.Write(b); err != nil {
			return nil, err
		}
		if err := w.Close(); err != nil {
			return nil, err
		}
	case "zlib":
		w := zlib.NewWriter(&buf)
		if _, err := w.Write(b); err != nil {
			return nil, err
		}
		if err := w.Close(); err != nil {
			return nil, err
		}
	default:
		return b, nil
	}
	return buf.Bytes(), nil
}

var errGelfTooLarge = errors.New("gelf message needs more than 128 chunks")

// chunkGelf splits a payload into GELF chunks (magic 1e 0f, 8-byte message id, seq, count, data) when it exceeds
// gelfChunkMax; a payload that fits goes out as a single datagram, unchunked. More than 128 chunks is an error.
func chunkGelf(payload []byte, id [8]byte) ([][]byte, error) {
	if len(payload) <= gelfChunkMax {
		return [][]byte{payload}, nil
	}
	size := gelfChunkMax - gelfChunkHdr
	count := (len(payload) + size - 1) / size
	if count > gelfMaxChunks {
		return nil, errGelfTooLarge
	}
	out := make([][]byte, 0, count)
	for i := 0; i < count; i++ {
		lo, hi := i*size, (i+1)*size
		if hi > len(payload) {
			hi = len(payload)
		}
		d := make([]byte, 0, gelfChunkHdr+hi-lo)
		d = append(d, 0x1e, 0x0f)
		d = append(d, id[:]...)
		d = append(d, byte(i), byte(count))
		d = append(d, payload[lo:hi]...)
		out = append(out, d)
	}
	return out, nil
}

type gelfSender struct {
	cs       *connSender
	proto    string
	compress string
	host     string
	appID    string
	now      func() time.Time
	newID    func() [8]byte
	// oversized counts messages that needed more than 128 chunks (dropped, never sent).
	oversized atomic.Int64
}

func randGelfID() (id [8]byte) {
	_, _ = rand.Read(id[:])
	return id
}

func newGelfSender(cfg protocol.DrainCfg) (Sender, error) {
	opt := cfg.Options
	if opt == nil {
		return nil, errors.New("gelf options required")
	}
	switch opt.Proto {
	case "udp", "tcp", "tls":
	default:
		return nil, errors.New("bad gelf proto")
	}
	comp := opt.Compress
	if comp == "" {
		comp = "gzip"
	}
	if opt.Proto != "udp" {
		comp = "none" // stream transports are never compressed
	}
	switch comp {
	case "none", "gzip", "zlib":
	default:
		return nil, errors.New("bad compress")
	}
	host, port, err := parseEndpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	var cs *connSender
	if opt.Proto == "tls" {
		tlsCfg, err := buildTLS(opt, host)
		if err != nil {
			return nil, err
		}
		cs = newConnSender("tls", host, port, cfg.Egress, tlsCfg)
	} else {
		cs = newConnSender(opt.Proto, host, port, cfg.Egress, nil)
	}
	return &gelfSender{cs: cs, proto: opt.Proto, compress: comp, host: cfg.Host, appID: cfg.AppID, now: time.Now, newID: randGelfID}, nil
}

func (g *gelfSender) Send(ctx context.Context, lines []LogLine) error {
	flush := g.now()
	if g.proto == "udp" {
		var dgrams [][]byte
		for _, l := range lines {
			js, err := buildGelf(g.host, g.appID, l, flush)
			if err != nil {
				return newDrainErr(errConfig, true, err)
			}
			payload, err := compressGelf(g.compress, js)
			if err != nil {
				return newDrainErr(errWrite, false, err)
			}
			chunks, err := chunkGelf(payload, g.newID())
			// The 64 KiB pre-cap is on the RAW text; JSON escaping can grow it up to 6x ('<', '&', control
			// characters), so an uncompressed message can still need more than 128 chunks. Shorten the text
			// (halving, on a rune boundary) until it fits before giving up on the line.
			for try := 0; err != nil && try < 8 && len(l.Message) > 1; try++ {
				cut := len(l.Message) / 2
				for cut > 0 && !utf8.RuneStart(l.Message[cut]) {
					cut--
				}
				l.Message = l.Message[:cut]
				if js, err = buildGelf(g.host, g.appID, l, flush); err != nil {
					return newDrainErr(errConfig, true, err)
				}
				if payload, err = compressGelf(g.compress, js); err != nil {
					return newDrainErr(errWrite, false, err)
				}
				chunks, err = chunkGelf(payload, g.newID())
			}
			if err != nil {
				g.oversized.Add(1) // surfaced through takeLoss as a dropped line (never as sent)
				continue
			}
			dgrams = append(dgrams, chunks...)
		}
		return g.cs.sendDatagrams(ctx, dgrams)
	}
	frames := make([][]byte, 0, len(lines))
	for _, l := range lines {
		js, err := buildGelf(g.host, g.appID, l, flush)
		if err != nil {
			return newDrainErr(errConfig, true, err)
		}
		frames = append(frames, append(js, 0)) // NUL-terminated, never compressed
	}
	return g.cs.sendStream(ctx, func(c net.Conn) error {
		bufs := net.Buffers(append([][]byte(nil), frames...))
		_, err := bufs.WriteTo(c)
		return err
	})
}

// takeLoss implements lossReporter: the oversized messages skipped since the last call.
func (g *gelfSender) takeLoss() (dropped, truncated int64) { return g.oversized.Swap(0), 0 }

func (g *gelfSender) Close() { g.cs.Close() }
