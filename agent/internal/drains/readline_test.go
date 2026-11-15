package drains

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReadLineCappedTruncatesAndContinues(t *testing.T) {
	big := strings.Repeat("x", 3*1024*1024)
	r := bufio.NewReaderSize(strings.NewReader(big+"\nsecond\r\nthird"), 4096)
	l1, err := readLineCapped(r, maxLineBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(l1) != maxLineBytes+len(truncatedMarker) || !strings.HasSuffix(l1, truncatedMarker) {
		t.Fatalf("first line: len %d, suffix %q", len(l1), l1[len(l1)-20:])
	}
	l2, _ := readLineCapped(r, maxLineBytes)
	if l2 != "second" { // \r\n stripped, reader stayed in sync
		t.Fatalf("second line = %q", l2)
	}
	l3, err := readLineCapped(r, maxLineBytes) // unterminated final line is still returned
	if err != nil || l3 != "third" {
		t.Fatalf("third line = %q err %v", l3, err)
	}
	if _, err := readLineCapped(r, maxLineBytes); err != io.EOF {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestReadLineCappedExactAndEmpty(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("abcd\n\nxy\n"))
	if l, _ := readLineCapped(r, 4); l != "abcd" { // exactly at the cap: NOT truncated
		t.Fatalf("exact cap line = %q", l)
	}
	if l, err := readLineCapped(r, 4); err != nil || l != "" {
		t.Fatalf("empty line = %q err %v", l, err)
	}
	if l, _ := readLineCapped(r, 1); l != "x"+truncatedMarker {
		t.Fatalf("cap 1 = %q", l)
	}
}

func TestSplitDockerTS(t *testing.T) {
	ts, msg := splitDockerTS("2026-11-15T10:00:00.123456789Z hello world")
	if msg != "hello world" || ts.UnixNano() != time.Date(2026, 11, 15, 10, 0, 0, 123456789, time.UTC).UnixNano() {
		t.Fatalf("parse: %v %q", ts, msg)
	}
	// parse failure: TS zero, message untouched
	for _, in := range []string{"not-a-timestamp hello", "nospace", "", " leading"} {
		ts, msg := splitDockerTS(in)
		if !ts.IsZero() || msg != in {
			t.Fatalf("fallback for %q: %v %q", in, ts, msg)
		}
	}
}

func TestPumpLinesTagsStream(t *testing.T) {
	var mu sync.Mutex
	var got []LogLine
	emit := func(l LogLine) { mu.Lock(); got = append(got, l); mu.Unlock() }
	pumpLines(strings.NewReader("2026-11-15T10:00:00Z out1\n2026-11-15T10:00:01Z out2\n"), "stdout", emit)
	pumpLines(strings.NewReader("garbage line\n"), "stderr", emit)
	if len(got) != 3 || got[0].Stream != "stdout" || got[0].Message != "out1" || got[0].TS.IsZero() ||
		got[2].Stream != "stderr" || got[2].Message != "garbage line" || !got[2].TS.IsZero() {
		t.Fatalf("pumped: %+v", got)
	}
}

func TestLogLineJSONOnlyContainerAndMessage(t *testing.T) {
	// the http format marshals LogLine directly: TS/Stream must NOT leak into those bytes
	b, err := json.Marshal(LogLine{Container: "c", Message: "m", TS: time.Now(), Stream: "stderr"})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"container":"c","message":"m"}` {
		t.Fatalf("LogLine JSON changed: %s", b)
	}
}

func TestParsePs(t *testing.T) {
	got := parsePs("abc123 tugra_app1-web-1\ndef456 tugra_app2,alias\n\nbad\n")
	if len(got) != 2 || got[0] != (psEntry{"abc123", "tugra_app1-web-1"}) || got[1] != (psEntry{"def456", "tugra_app2"}) {
		t.Fatalf("parsePs: %+v", got)
	}
}
