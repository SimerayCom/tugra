package drains

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

func hx(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Vectors are hand-derived from the MessagePack spec format table (not produced by this encoder).
func TestMsgpackEncodeVectors(t *testing.T) {
	cases := []struct {
		name string
		fn   func(e *mpEnc)
		want string
	}{
		{"nil", func(e *mpEnc) { e.nil_() }, "c0"},
		{"false", func(e *mpEnc) { e.bool_(false) }, "c2"},
		{"true", func(e *mpEnc) { e.bool_(true) }, "c3"},
		{"uint 0 (positive fixint)", func(e *mpEnc) { e.uint_(0) }, "00"},
		{"uint 127 (positive fixint max)", func(e *mpEnc) { e.uint_(127) }, "7f"},
		{"uint 128 (uint8)", func(e *mpEnc) { e.uint_(128) }, "cc 80"},
		{"uint 255", func(e *mpEnc) { e.uint_(255) }, "cc ff"},
		{"uint 256 (uint16)", func(e *mpEnc) { e.uint_(256) }, "cd 01 00"},
		{"uint 65535", func(e *mpEnc) { e.uint_(65535) }, "cd ff ff"},
		{"uint 65536 (uint32)", func(e *mpEnc) { e.uint_(65536) }, "ce 00 01 00 00"},
		{"uint 4294967295", func(e *mpEnc) { e.uint_(4294967295) }, "ce ff ff ff ff"},
		{"uint 4294967296 (uint64)", func(e *mpEnc) { e.uint_(4294967296) }, "cf 00 00 00 01 00 00 00 00"},
		{"empty str (fixstr)", func(e *mpEnc) { e.str("") }, "a0"},
		{"str a", func(e *mpEnc) { e.str("a") }, "a1 61"},
		{"str 31 (fixstr max)", func(e *mpEnc) { e.str(strings.Repeat("a", 31)) }, "bf " + strings.Repeat("61", 31)},
		{"str 32 (str8)", func(e *mpEnc) { e.str(strings.Repeat("a", 32)) }, "d9 20 " + strings.Repeat("61", 32)},
		{"str 256 (str16)", func(e *mpEnc) { e.str(strings.Repeat("a", 256)) }, "da 01 00 " + strings.Repeat("61", 256)},
		{"str 65536 (str32)", func(e *mpEnc) { e.str(strings.Repeat("a", 65536)) }, "db 00 01 00 00 " + strings.Repeat("61", 65536)},
		{"bin 3 (bin8)", func(e *mpEnc) { e.bin([]byte{1, 2, 3}) }, "c4 03 01 02 03"},
		{"bin 256 (bin16)", func(e *mpEnc) { e.bin(make([]byte, 256)) }, "c5 01 00 " + strings.Repeat("00", 256)},
		{"bin 65536 (bin32)", func(e *mpEnc) { e.bin(make([]byte, 65536)) }, "c6 00 01 00 00 " + strings.Repeat("00", 65536)},
		{"array 0", func(e *mpEnc) { e.arrayHeader(0) }, "90"},
		{"array 15 (fixarray max)", func(e *mpEnc) { e.arrayHeader(15) }, "9f"},
		{"array 16 (array16)", func(e *mpEnc) { e.arrayHeader(16) }, "dc 00 10"},
		{"array 65536 (array32)", func(e *mpEnc) { e.arrayHeader(65536) }, "dd 00 01 00 00"},
		{"map 0", func(e *mpEnc) { e.mapHeader(0) }, "80"},
		{"map 15 (fixmap max)", func(e *mpEnc) { e.mapHeader(15) }, "8f"},
		{"map 16 (map16)", func(e *mpEnc) { e.mapHeader(16) }, "de 00 10"},
		{"map 65536 (map32)", func(e *mpEnc) { e.mapHeader(65536) }, "df 00 01 00 00"},
		// fluentd EventTime: fixext 8 (d7), ext type 0, uint32 seconds, uint32 nanoseconds
		{"EventTime 1s 2ns", func(e *mpEnc) { e.eventTime(time.Unix(1, 2)) }, "d7 00 00 00 00 01 00 00 00 02"},
		{"EventTime 1731664800s 123456789ns", func(e *mpEnc) { e.eventTime(time.Unix(1731664800, 123456789)) }, "d7 00 67 37 1b a0 07 5b cd 15"},
	}
	for _, c := range cases {
		var e mpEnc
		c.fn(&e)
		if !bytes.Equal(e.b, hx(t, c.want)) {
			got := hex.EncodeToString(e.b)
			if len(got) > 60 {
				got = got[:60] + "..."
			}
			t.Errorf("%s: got %s", c.name, got)
		}
	}
}

func TestMsgpackDecodeVectors(t *testing.T) {
	cases := []struct {
		in   string
		want any
	}{
		{"c0", nil}, {"c2", false}, {"c3", true},
		{"00", int64(0)}, {"7f", int64(127)}, {"e0", int64(-32)}, {"ff", int64(-1)},
		{"cc 80", int64(128)}, {"cd 01 00", int64(256)}, {"ce 00 01 00 00", int64(65536)},
		{"cf ff ff ff ff ff ff ff ff", uint64(math.MaxUint64)},
		{"d0 ff", int64(-1)}, {"d0 80", int64(-128)}, {"d1 ff 00", int64(-256)}, {"d2 ff ff ff 00", int64(-256)},
		{"d3 ff ff ff ff ff ff ff ff", int64(-1)},
		{"ca 3f c0 00 00", float64(1.5)}, {"cb 3f f8 00 00 00 00 00 00", float64(1.5)},
		{"a0", ""}, {"a3 61 62 63", "abc"}, {"d9 03 61 62 63", "abc"}, {"da 00 03 61 62 63", "abc"}, {"db 00 00 00 03 61 62 63", "abc"},
		{"c4 02 01 02", []byte{1, 2}}, {"c5 00 02 01 02", []byte{1, 2}}, {"c6 00 00 00 02 01 02", []byte{1, 2}},
		{"92 01 a1 78", []any{int64(1), "x"}}, {"dc 00 01 c3", []any{true}}, {"dd 00 00 00 01 c0", []any{nil}},
		{"81 a3 61 63 6b a1 78", map[string]any{"ack": "x"}}, {"de 00 01 a1 6b 01", map[string]any{"k": int64(1)}},
		{"d7 00 00 00 00 01 00 00 00 02", mpExt{Type: 0, Data: []byte{0, 0, 0, 1, 0, 0, 0, 2}}},
		{"c7 02 05 aa bb", mpExt{Type: 5, Data: []byte{0xaa, 0xbb}}},
	}
	for _, c := range cases {
		got, err := mpDecode(bufio.NewReader(bytes.NewReader(hx(t, c.in))))
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("decode %s: got %#v err %v, want %#v", c.in, got, err, c.want)
		}
	}
}

func TestMsgpackDecodeRejectsHostileInput(t *testing.T) {
	bad := map[string]string{
		"reserved 0xc1":          "c1",
		"truncated str":          "a5 61",
		"non-string map key":     "81 01 01",
		"huge array count":       "dd 7f ff ff ff",
		"huge str length":        "db ff ff ff ff",
		"oversized bin":          "c6 7f ff ff ff",
		"empty input":            "",
		"truncated array":        "93 01 02",
		"deep nesting":           strings.Repeat("91", 20) + "00",
		"map count over the cap": "de ff ff",
	}
	for name, in := range bad {
		if _, err := mpDecode(bufio.NewReader(bytes.NewReader(hx(t, in)))); err == nil {
			t.Errorf("%s must be rejected", name)
		}
	}
}

func TestMsgpackRoundTripThroughOwnEncoder(t *testing.T) {
	var e mpEnc
	e.mapHeader(3)
	e.str("n")
	e.uint_(70000)
	e.str("s")
	e.str(strings.Repeat("é", 40))
	e.str("a")
	e.arrayHeader(2)
	e.bin([]byte("raw"))
	e.nil_()
	got, err := mpDecode(bufio.NewReader(bytes.NewReader(e.b)))
	want := map[string]any{"n": int64(70000), "s": strings.Repeat("é", 40), "a": []any{[]byte("raw"), nil}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip: %#v %v", got, err)
	}
}

func TestMsgpackDecodeBudgetStopsNilAmplification(t *testing.T) {
	// outer array16(4096) of 4096 x array16(4096 x nil): ~16.8 MB on the wire, ~270 MB decoded without a total budget.
	var e mpEnc
	e.b = append(e.b, 0xdc, 0x10, 0x00)
	inner := append([]byte{0xdc, 0x10, 0x00}, bytes.Repeat([]byte{0xc0}, 4096)...)
	for i := 0; i < 4096; i++ {
		e.b = append(e.b, inner...)
	}
	if _, err := mpDecode(bufio.NewReader(bytes.NewReader(e.b))); !errors.Is(err, errMsgpack) {
		t.Fatalf("amplification payload must fail with errMsgpack, got %v", err)
	}
	// a single flat array of nils over the element budget is refused too, without allocating by the declared count
	flat := append([]byte{0xdc, 0x10, 0x00}, bytes.Repeat([]byte{0xc0}, 4096)...)
	if _, err := mpDecode(bufio.NewReader(bytes.NewReader(flat))); !errors.Is(err, errMsgpack) {
		t.Fatalf("flat nil array over the element budget must fail, got %v", err)
	}
	// a normal ack / HELO shaped value still decodes under the default budget
	var ok mpEnc
	ok.mapHeader(1)
	ok.str("ack")
	ok.str(strings.Repeat("a", 24))
	if v, err := mpDecode(bufio.NewReader(bytes.NewReader(ok.b))); err != nil || v.(map[string]any)["ack"] == nil {
		t.Fatalf("normal ack: %v %v", v, err)
	}
	// the explicit limit is honoured
	if _, err := mpDecodeLimited(bufio.NewReader(bytes.NewReader(ok.b)), 8, 8); !errors.Is(err, errMsgpack) {
		t.Fatalf("tiny budget must refuse an ack, got %v", err)
	}
}
