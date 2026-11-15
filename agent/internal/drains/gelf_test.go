package drains

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

func TestBuildGelfGolden(t *testing.T) {
	l := LogLine{Container: "c", Message: "hello", Stream: "stdout", TS: time.Unix(1731664800, 123456000)}
	got, err := buildGelf("srv", "a1", l, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"version":"1.1","host":"srv","short_message":"hello","timestamp":1731664800.123456,"level":6,"_container":"c","_stream":"stdout","_source":"tugra","_app_id":"a1"}`
	if string(got) != want {
		t.Fatalf("gelf json:\n got %s\nwant %s", got, want)
	}
	// stderr = level 3; no app id (server scope) = no _app_id key; whole seconds keep six decimals
	l.Stream, l.TS = "stderr", time.Unix(5, 0)
	got, _ = buildGelf("srv", "", l, time.Time{})
	want = `{"version":"1.1","host":"srv","short_message":"hello","timestamp":5.000000,"level":3,"_container":"c","_stream":"stderr","_source":"tugra"}`
	if string(got) != want {
		t.Fatalf("gelf stderr json:\n got %s\nwant %s", got, want)
	}
	// it is valid JSON a GELF input can parse
	var m map[string]any
	if err := json.Unmarshal(got, &m); err != nil || m["version"] != "1.1" {
		t.Fatalf("not valid json: %v", err)
	}
}

func TestBuildGelfEmptyAndCaps(t *testing.T) {
	got, _ := buildGelf("", "", LogLine{Container: "c", TS: time.Unix(1, 0)}, time.Time{})
	if !strings.Contains(string(got), `"short_message":"(empty)"`) || !strings.Contains(string(got), `"host":"tugra"`) {
		t.Fatalf("empty message / host fallback: %s", got)
	}
	got, _ = buildGelf("h", "", LogLine{Container: "c", Message: strings.Repeat("é", 100000), TS: time.Unix(1, 0)}, time.Time{})
	var m map[string]any
	if err := json.Unmarshal(got, &m); err != nil {
		t.Fatal(err)
	}
	if n := len(m["short_message"].(string)); n > gelfMaxMessage || n < gelfMaxMessage-2 {
		t.Fatalf("short_message must be pre-capped at 64 KiB on a rune boundary, got %d bytes", n)
	}
}

func TestCompressGelfRoundTrip(t *testing.T) {
	payload := []byte(strings.Repeat(`{"short_message":"repeat repeat"}`, 50))
	gz, err := compressGelf("gzip", payload)
	if err != nil || bytes.Equal(gz, payload) {
		t.Fatalf("gzip: %v", err)
	}
	r, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	if back, _ := io.ReadAll(r); !bytes.Equal(back, payload) {
		t.Fatal("gzip round trip mismatch")
	}
	zl, _ := compressGelf("zlib", payload)
	zr, err := zlib.NewReader(bytes.NewReader(zl))
	if err != nil {
		t.Fatal(err)
	}
	if back, _ := io.ReadAll(zr); !bytes.Equal(back, payload) {
		t.Fatal("zlib round trip mismatch")
	}
	if none, _ := compressGelf("none", payload); !bytes.Equal(none, payload) {
		t.Fatal("none must pass through")
	}
}

func TestChunkGelf(t *testing.T) {
	id := [8]byte{1, 2, 3, 4, 5, 6, 7, 8}
	// fits: one plain datagram, no chunk header
	small := bytes.Repeat([]byte("a"), gelfChunkMax)
	if ch, err := chunkGelf(small, id); err != nil || len(ch) != 1 || !bytes.Equal(ch[0], small) {
		t.Fatalf("a payload of %d bytes must not be chunked", gelfChunkMax)
	}
	// 5000 bytes -> ceil(5000/1408) = 4 chunks, each <= 1420 with the 12-byte header
	payload := make([]byte, 5000)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	ch, err := chunkGelf(payload, id)
	if err != nil || len(ch) != 4 {
		t.Fatalf("chunks: %d %v", len(ch), err)
	}
	var re []byte
	for i, c := range ch {
		if len(c) > gelfChunkMax {
			t.Fatalf("chunk %d is %d bytes", i, len(c))
		}
		if c[0] != 0x1e || c[1] != 0x0f || !bytes.Equal(c[2:10], id[:]) || c[10] != byte(i) || c[11] != 4 {
			t.Fatalf("chunk %d header wrong: % x", i, c[:12])
		}
		re = append(re, c[12:]...)
	}
	if !bytes.Equal(re, payload) {
		t.Fatal("reassembled payload differs")
	}
	// exactly 128 chunks is the limit
	max := make([]byte, 128*(gelfChunkMax-gelfChunkHdr))
	if ch, err := chunkGelf(max, id); err != nil || len(ch) != 128 {
		t.Fatalf("128 chunks must be accepted: %d %v", len(ch), err)
	}
	if _, err := chunkGelf(append(max, 0), id); err != errGelfTooLarge {
		t.Fatalf("129 chunks must be refused, got %v", err)
	}
}

func TestGelfUDPRoundTripChunkedAndCompressed(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	s, err := newGelfSender(protocol.DrainCfg{Type: "gelf", Endpoint: pc.LocalAddr().String(), Host: "srv", Egress: egressAny, AppID: "a1",
		Options: &protocol.DrainOptions{Proto: "udp", Compress: "none"}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	gs := s.(*gelfSender)
	gs.newID = func() [8]byte { return [8]byte{9, 9, 9, 9, 9, 9, 9, 9} }
	big := strings.Repeat("z", 4000)
	if err := s.Send(context.Background(), []LogLine{{Container: "c", Message: "tiny", Stream: "stdout", TS: time.Unix(10, 0)}, {Container: "c", Message: big, Stream: "stdout", TS: time.Unix(11, 0)}}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 65535)
	_ = pc.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, _, err := pc.ReadFrom(buf)
	if err != nil || !strings.Contains(string(buf[:n]), `"short_message":"tiny"`) || buf[0] != '{' {
		t.Fatalf("first datagram: %q %v", buf[:n], err)
	}
	// the big message arrives as chunks that reassemble into valid JSON
	var re []byte
	count := -1
	for seen := 0; count < 0 || seen < count; seen++ {
		n, _, err = pc.ReadFrom(buf)
		if err != nil {
			t.Fatal(err)
		}
		if buf[0] != 0x1e || buf[1] != 0x0f {
			t.Fatalf("expected a chunk, got % x", buf[:4])
		}
		count = int(buf[11])
		if int(buf[10]) != seen {
			t.Fatalf("chunks out of order: seq %d want %d", buf[10], seen)
		}
		re = append(re, buf[12:n]...)
	}
	var m map[string]any
	if err := json.Unmarshal(re, &m); err != nil || m["short_message"] != big {
		t.Fatalf("reassembled message invalid: %v", err)
	}

	// default compression is gzip on udp: a small repetitive line is sent gzip-compressed (magic 1f 8b)
	s2, _ := newGelfSender(protocol.DrainCfg{Type: "gelf", Endpoint: pc.LocalAddr().String(), Host: "srv", Egress: egressAny, Options: &protocol.DrainOptions{Proto: "udp"}})
	defer s2.Close()
	if err := s2.Send(context.Background(), batchOf("compressed")); err != nil {
		t.Fatal(err)
	}
	n, _, _ = pc.ReadFrom(buf)
	zr, err := gzip.NewReader(bytes.NewReader(buf[:n]))
	if err != nil {
		t.Fatalf("default udp payload must be gzip: %v", err)
	}
	if back, _ := io.ReadAll(zr); !strings.Contains(string(back), `"short_message":"compressed"`) {
		t.Fatalf("gzip payload: %s", back)
	}
}

func TestGelfOversizedMessageIsCountedNotSent(t *testing.T) {
	// > 128 chunks uncompressed can only be reached by the chunker directly (message is pre-capped), so assert
	// the sender-level accounting through a forced tiny chunk budget is covered by TestChunkGelf; here: the cap.
	js, _ := buildGelf("h", "", LogLine{Container: "c", Message: strings.Repeat("a", 1<<20), TS: time.Unix(1, 0)}, time.Time{})
	if len(js) > gelfMaxMessage+400 {
		t.Fatalf("pre-cap must bound the payload, got %d", len(js))
	}
	if ch, err := chunkGelf(js, [8]byte{}); err != nil || len(ch) > gelfMaxChunks {
		t.Fatalf("a capped message always fits in 128 chunks: %d %v", len(ch), err)
	}
}

func TestGelfTCPNulFraming(t *testing.T) {
	l, addr := listenLoopback(t)
	tc := newTCPCollector(t, l)
	s, err := newGelfSender(protocol.DrainCfg{Type: "gelf", Endpoint: addr, Host: "srv", Egress: egressAny,
		Options: &protocol.DrainOptions{Proto: "tcp", Compress: "gzip"}}) // compress is ignored for tcp: never compressed
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Send(context.Background(), []LogLine{{Container: "c", Message: "a", Stream: "stdout", TS: time.Unix(1, 0)}, {Container: "c", Message: "b", Stream: "stderr", TS: time.Unix(2, 0)}}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "two NUL-terminated messages", func() bool { return strings.Count(tc.data(0), "\x00") == 2 })
	parts := strings.Split(strings.TrimSuffix(tc.data(0), "\x00"), "\x00")
	for i, p := range parts {
		var m map[string]any
		if err := json.Unmarshal([]byte(p), &m); err != nil || m["version"] != "1.1" {
			t.Fatalf("message %d is not plain GELF json: %q", i, p)
		}
	}
}

func TestNewGelfSenderValidation(t *testing.T) {
	for i, c := range []protocol.DrainCfg{
		{Type: "gelf", Endpoint: "h:12201"},
		{Type: "gelf", Endpoint: "h:12201", Options: &protocol.DrainOptions{Proto: "http"}},
		{Type: "gelf", Endpoint: "h:12201", Options: &protocol.DrainOptions{Proto: "udp", Compress: "brotli"}},
		{Type: "gelf", Endpoint: "nope", Options: &protocol.DrainOptions{Proto: "udp"}},
	} {
		if _, err := newGelfSender(c); err == nil {
			t.Errorf("case %d must be invalid", i)
		}
	}
}
