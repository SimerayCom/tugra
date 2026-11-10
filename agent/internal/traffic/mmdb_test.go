package traffic

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"math/big"
	"math/rand"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ---- a minimal MaxMind DB writer, test-only: it builds databases of every record size and IP version so the
// reader is exercised well beyond the two tiny checked-in fixtures. ----

type mmPtr struct{ off int } // an explicit pointer to a data-section offset

type mmWriter struct {
	buf  bytes.Buffer
	seen map[string]int // string -> offset of its first inline encoding (later uses become pointers)
}

func newMMWriter() *mmWriter { return &mmWriter{seen: map[string]int{}} }

func (w *mmWriter) ctrl(typ, size int) {
	tbits := typ
	if typ > 7 {
		tbits = 0
	}
	var ext []byte
	if typ > 7 {
		ext = []byte{byte(typ - 7)}
	}
	switch {
	case size < 29:
		w.buf.WriteByte(byte(tbits<<5 | size))
		w.buf.Write(ext)
	case size < 285:
		w.buf.WriteByte(byte(tbits<<5 | 29))
		w.buf.Write(ext)
		w.buf.WriteByte(byte(size - 29))
	case size < 65821:
		w.buf.WriteByte(byte(tbits<<5 | 30))
		w.buf.Write(ext)
		v := size - 285
		w.buf.Write([]byte{byte(v >> 8), byte(v)})
	default:
		w.buf.WriteByte(byte(tbits<<5 | 31))
		w.buf.Write(ext)
		v := size - 65821
		w.buf.Write([]byte{byte(v >> 16), byte(v >> 8), byte(v)})
	}
}

func (w *mmWriter) pointer(p int) {
	switch {
	case p < 2048:
		w.buf.Write([]byte{byte(1<<5 | 0<<3 | p>>8), byte(p)})
	case p < 2048+524288:
		v := p - 2048
		w.buf.Write([]byte{byte(1<<5 | 1<<3 | v>>16), byte(v >> 8), byte(v)})
	case p < 526336+134217728:
		v := p - 526336
		w.buf.Write([]byte{byte(1<<5 | 2<<3 | v>>24), byte(v >> 16), byte(v >> 8), byte(v)})
	default:
		w.buf.Write([]byte{1<<5 | 3<<3, byte(p >> 24), byte(p >> 16), byte(p >> 8), byte(p)})
	}
}

func uintBytes(v uint64, max int) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	i := 0
	for i < 8 && b[i] == 0 {
		i++
	}
	out := b[i:]
	if len(out) > max {
		panic("value too large")
	}
	return out
}

// put encodes a value and returns the offset it starts at. Strings repeat as pointers (dedupe) unless inline.
func (w *mmWriter) put(v any) int {
	start := w.buf.Len()
	switch x := v.(type) {
	case string:
		if off, ok := w.seen[x]; ok && len(x) > 0 {
			w.pointer(off)
			return start
		}
		w.seen[x] = start
		w.ctrl(mmdbString, len(x))
		w.buf.WriteString(x)
	case mmPtr:
		w.pointer(x.off)
	case []byte:
		w.ctrl(mmdbBytes, len(x))
		w.buf.Write(x)
	case float64:
		w.ctrl(mmdbDouble, 8)
		_ = binary.Write(&w.buf, binary.BigEndian, x)
	case float32:
		w.ctrl(mmdbFloat, 4)
		_ = binary.Write(&w.buf, binary.BigEndian, x)
	case uint16:
		b := uintBytes(uint64(x), 2)
		w.ctrl(mmdbUint16, len(b))
		w.buf.Write(b)
	case uint32:
		b := uintBytes(uint64(x), 4)
		w.ctrl(mmdbUint32, len(b))
		w.buf.Write(b)
	case uint64:
		b := uintBytes(x, 8)
		w.ctrl(mmdbUint64, len(b))
		w.buf.Write(b)
	case int32:
		if x < 0 {
			w.ctrl(mmdbInt32, 4)
			_ = binary.Write(&w.buf, binary.BigEndian, x)
		} else {
			b := uintBytes(uint64(x), 4)
			w.ctrl(mmdbInt32, len(b))
			w.buf.Write(b)
		}
	case *big.Int:
		b := x.Bytes()
		w.ctrl(mmdbUint128, len(b))
		w.buf.Write(b)
	case bool:
		n := 0
		if x {
			n = 1
		}
		w.ctrl(mmdbBoolean, n)
	case []any:
		w.ctrl(mmdbArray, len(x))
		for _, e := range x {
			w.put(e)
		}
	case mmMap:
		w.ctrl(mmdbMap, len(x))
		for _, kv := range x {
			w.put(kv.k)
			w.put(kv.v)
		}
	default:
		panic(fmt.Sprintf("unsupported %T", v))
	}
	return start
}

type mmKV struct {
	k string
	v any
}
type mmMap []mmKV // ordered, so output is deterministic

type mmEntry struct {
	kind int // 0 empty, 1 node, 2 data
	v    int
}

type mmTree struct {
	ipVersion int
	nodes     [][2]mmEntry
}

func newMMTree(ipVersion int) *mmTree {
	return &mmTree{ipVersion: ipVersion, nodes: [][2]mmEntry{{}}}
}

// insert maps prefix -> data offset. IPv4 prefixes in an IPv6 tree live under ::/96.
func (t *mmTree) insert(p netip.Prefix, dataOff int) {
	var bits []byte
	n := p.Bits()
	if p.Addr().Is4() {
		a := p.Addr().As4()
		bits = a[:]
		if t.ipVersion == 6 {
			bits = append(make([]byte, 12), bits...)
			n += 96
		}
	} else {
		a := p.Addr().As16()
		bits = a[:]
	}
	cur := 0
	for i := 0; i < n; i++ {
		bit := (bits[i/8] >> (7 - uint(i%8))) & 1
		e := t.nodes[cur][bit]
		last := i == n-1
		switch {
		case last:
			t.nodes[cur][bit] = mmEntry{2, dataOff}
		case e.kind == 1:
			cur = e.v
		default:
			t.nodes = append(t.nodes, [2]mmEntry{e, e}) // split an existing data entry (or start fresh)
			t.nodes[cur][bit] = mmEntry{1, len(t.nodes) - 1}
			cur = len(t.nodes) - 1
		}
	}
}

// build serialises tree + separator + data + metadata. pad bytes are prepended to the data section (to push
// data offsets past the 24-bit and pointer-size boundaries).
func (t *mmTree) build(recBits int, data []byte) []byte {
	nc := len(t.nodes)
	rec := func(e mmEntry) uint64 {
		switch e.kind {
		case 1:
			return uint64(e.v)
		case 2:
			return uint64(nc) + 16 + uint64(e.v)
		}
		return uint64(nc)
	}
	var out bytes.Buffer
	for _, n := range t.nodes {
		l, r := rec(n[0]), rec(n[1])
		switch recBits {
		case 24:
			out.Write([]byte{byte(l >> 16), byte(l >> 8), byte(l), byte(r >> 16), byte(r >> 8), byte(r)})
		case 28:
			out.Write([]byte{byte(l >> 16), byte(l >> 8), byte(l), byte(l>>24)<<4 | byte(r>>24)&0x0f, byte(r >> 16), byte(r >> 8), byte(r)})
		case 32:
			out.Write([]byte{byte(l >> 24), byte(l >> 16), byte(l >> 8), byte(l), byte(r >> 24), byte(r >> 16), byte(r >> 8), byte(r)})
		}
	}
	out.Write(make([]byte, 16))
	out.Write(data)
	out.WriteString(mmdbMetaMarker)
	mw := newMMWriter()
	mw.put(mmMap{
		{"binary_format_major_version", uint16(2)}, {"binary_format_minor_version", uint16(0)},
		{"build_epoch", uint64(1700000000)}, {"database_type", "Test-City"},
		{"description", mmMap{{"en", "test"}}}, {"ip_version", uint16(t.ipVersion)},
		{"languages", []any{"en"}}, {"node_count", uint32(nc)}, {"record_size", uint16(recBits)},
	})
	out.Write(mw.buf.Bytes())
	return out.Bytes()
}

// geoRec builds a country (+ optional city) record the way a City edition lays it out.
func geoRec(iso, city string) mmMap {
	m := mmMap{{"country", mmMap{{"iso_code", iso}, {"names", mmMap{{"en", "Country " + iso}}}}}}
	if city != "" {
		m = append(m, mmKV{"city", mmMap{{"geoname_id", uint32(2643743)}, {"names", mmMap{{"en", city}, {"de", "Stadt"}}}}})
	}
	m = append(m, mmKV{"location", mmMap{{"latitude", 51.5142}, {"longitude", -0.0931}, {"accuracy_radius", uint16(200)}}})
	return m
}

// buildGeoDB makes a database with IPv4 and (for ipVersion 6) IPv6 networks. Records share strings, so most
// keys and values are pointers.
func buildGeoDB(t *testing.T, recBits, ipVersion, padBytes int) []byte {
	t.Helper()
	tr := newMMTree(ipVersion)
	w := newMMWriter()
	for left := padBytes; left > 0; {
		n := left
		if n > 16_000_000 {
			n = 16_000_000
		}
		w.put(make([]byte, n)) // unreferenced filler that pushes later offsets up
		left -= n
	}
	add := func(cidr, iso, city string) {
		off := w.put(geoRec(iso, city))
		tr.insert(netip.MustParsePrefix(cidr), off)
	}
	add("81.2.69.0/24", "GB", "London")
	add("81.2.69.142/31", "GB", "Boxford") // more specific, forces a split
	add("89.160.20.0/24", "SE", "Linköping")
	add("1.0.0.0/8", "AU", "")
	if ipVersion == 6 {
		add("2a02:6b8::/32", "DE", "Berlin")
		add("2001:db8:ffff::/48", "FR", "")
	}
	return tr.build(recBits, w.buf.Bytes())
}

func mustOpen(t *testing.T, b []byte) *mmdbReader {
	t.Helper()
	r, err := newMMDB(b)
	if err != nil {
		t.Fatalf("newMMDB: %v", err)
	}
	return r
}

func str(r *mmdbReader, ip string, path ...string) string {
	s, _ := r.lookupString(netip.MustParseAddr(ip), path...)
	return s
}

func TestMMDBRecordSizesAndIPVersions(t *testing.T) {
	for _, recBits := range []int{24, 28, 32} {
		for _, ipv := range []int{4, 6} {
			t.Run(fmt.Sprintf("rec%d_ip%d", recBits, ipv), func(t *testing.T) {
				r := mustOpen(t, buildGeoDB(t, recBits, ipv, 0))
				if r.recBits != uint32(recBits) || r.ipVersion != uint16(ipv) {
					t.Fatalf("metadata rec=%d ip=%d", r.recBits, r.ipVersion)
				}
				v4 := map[string][2]string{
					"81.2.69.10":       {"GB", "London"},
					"81.2.69.142":      {"GB", "Boxford"},
					"81.2.69.143":      {"GB", "Boxford"},
					"81.2.69.144":      {"GB", "London"},
					"89.160.20.5":      {"SE", "Linköping"},
					"1.2.3.4":          {"AU", ""},
					"::ffff:81.2.69.1": {"GB", "London"}, // v4-mapped
					"8.8.8.8":          {"", ""},         // not found
					"0.0.0.0":          {"", ""},
					"255.255.255.255":  {"", ""},
				}
				for ip, want := range v4 {
					if got := str(r, ip, "country", "iso_code"); got != want[0] {
						t.Errorf("%s country=%q want %q", ip, got, want[0])
					}
					if got := str(r, ip, "city", "names", "en"); got != want[1] {
						t.Errorf("%s city=%q want %q", ip, got, want[1])
					}
				}
				v6 := map[string]string{"2a02:6b8::5": "DE", "2a02:6b9::1": "", "2001:db8:ffff::1": "FR", "::1": ""}
				for ip, want := range v6 {
					got := str(r, ip, "country", "iso_code")
					if ipv == 4 {
						want = "" // an IPv6 address in an IPv4-only tree is a miss
					}
					if got != want {
						t.Errorf("%s country=%q want %q", ip, got, want)
					}
				}
				// Missing keys / wrong types are "not ok", not panics.
				if _, ok := r.lookupString(netip.MustParseAddr("1.2.3.4"), "city", "names", "en"); ok {
					t.Error("country-only record must have no city")
				}
				if _, ok := r.lookupString(netip.MustParseAddr("81.2.69.10"), "location", "latitude"); ok {
					t.Error("a double is not a string")
				}
				if _, ok := r.lookupString(netip.MustParseAddr("81.2.69.10"), "country", "iso_code", "deeper"); ok {
					t.Error("descending into a string must fail")
				}
				if _, ok := r.lookupString(netip.Addr{}, "country"); ok {
					t.Error("zero addr must miss")
				}
			})
		}
	}
}

// Pointer-heavy records and every pointer width: records placed after large filler sit beyond 2 KiB, 512 KiB
// and (for 28/32-bit trees) 16 MiB, so tree records and data pointers use the wide forms.
func TestMMDBLargeOffsetsAndPointerWidths(t *testing.T) {
	for _, c := range []struct{ rec, pad int }{{24, 3000}, {24, 700_000}, {28, 17_000_000}, {32, 17_000_000}} {
		t.Run(fmt.Sprintf("rec%d_pad%d", c.rec, c.pad), func(t *testing.T) {
			r := mustOpen(t, buildGeoDB(t, c.rec, 6, c.pad))
			if got := str(r, "81.2.69.10", "country", "iso_code"); got != "GB" {
				t.Fatalf("country=%q", got)
			}
			if got := str(r, "2a02:6b8::5", "city", "names", "en"); got != "Berlin" {
				t.Fatalf("city=%q", got)
			}
			if got := str(r, "89.160.20.5", "city", "names", "en"); got != "Linköping" {
				t.Fatalf("city=%q", got)
			}
		})
	}
	// Strings first seen after the filler are pointed at from later records with a wide pointer.
	tr, w := newMMTree(4), newMMWriter()
	w.put(make([]byte, 600_000))
	a := w.put(mmMap{{"city", mmMap{{"names", mmMap{{"en", "Zed"}}}}}})
	b := w.put(mmMap{{"city", mmMap{{"names", mmMap{{"en", "Zed"}}}}}}) // "Zed" -> pointer past 512 KiB
	tr.insert(netip.MustParsePrefix("10.0.0.0/8"), a)
	tr.insert(netip.MustParsePrefix("11.0.0.0/8"), b)
	r := mustOpen(t, tr.build(24, w.buf.Bytes()))
	for _, ip := range []string{"10.1.1.1", "11.1.1.1"} {
		if got := str(r, ip, "city", "names", "en"); got != "Zed" {
			t.Errorf("%s -> %q", ip, got)
		}
	}
}

func TestMMDBDecodeAllTypes(t *testing.T) {
	long := string(bytes.Repeat([]byte("x"), 70000)) // size > 65820: the 3-byte size form
	mid := string(bytes.Repeat([]byte("y"), 300))    // 285..65820: the 2-byte size form
	w := newMMWriter()
	str1 := w.put("hello")
	off := w.put(mmMap{
		{"s", "hello"}, // pointer to str1
		{"long", long}, {"mid", mid}, {"empty", ""},
		{"u16", uint16(65535)}, {"u16z", uint16(0)}, {"u32", uint32(4294967295)}, {"u64", uint64(math.MaxUint64)},
		{"i32", int32(-5)}, {"i32p", int32(7)}, {"u128", new(big.Int).Lsh(big.NewInt(1), 100)},
		{"d", 3.5}, {"f", float32(1.5)}, {"t", true}, {"f2", false},
		{"b", []byte{1, 2, 3}},
		{"arr", []any{"hello", uint16(1), mmMap{{"k", "v"}}}},
		{"ptr", mmPtr{str1}},
	})
	tr := newMMTree(4)
	tr.insert(netip.MustParsePrefix("1.2.3.0/24"), off)
	r := mustOpen(t, tr.build(24, w.buf.Bytes()))
	o, ok := r.find(netip.MustParseAddr("1.2.3.4"))
	if !ok {
		t.Fatal("record not found")
	}
	v, _, err := r.data.decode(o, 0)
	if err != nil {
		t.Fatal(err)
	}
	m := v.(map[string]any)
	want := map[string]any{
		"s": "hello", "long": long, "mid": mid, "empty": "", "u16": uint64(65535), "u16z": uint64(0),
		"u32": uint64(4294967295), "u64": uint64(math.MaxUint64), "i32": int32(-5), "i32p": int32(7),
		"d": 3.5, "f": 1.5, "t": true, "f2": false, "ptr": "hello",
	}
	for k, wv := range want {
		if m[k] != wv {
			t.Errorf("%s = %#v want %#v", k, m[k], wv)
		}
	}
	if m["u128"].(*big.Int).Cmp(new(big.Int).Lsh(big.NewInt(1), 100)) != 0 {
		t.Errorf("u128 = %v", m["u128"])
	}
	if !bytes.Equal(m["b"].([]byte), []byte{1, 2, 3}) {
		t.Errorf("bytes = %v", m["b"])
	}
	arr := m["arr"].([]any)
	if len(arr) != 3 || arr[0] != "hello" || arr[1] != uint64(1) || arr[2].(map[string]any)["k"] != "v" {
		t.Errorf("arr = %#v", arr)
	}
	// skip() must agree with decode() about where each top-level value ends: path lookups rely on it.
	for _, k := range []string{"ptr", "arr", "b", "u128", "t"} {
		if got, ok := r.lookupAt(o, k); ok && k != "ptr" {
			t.Errorf("%s is not a string, got %q", k, got)
		}
	}
	if s, ok := r.lookupAt(o, "ptr"); !ok || s != "hello" {
		t.Errorf("ptr -> %q %v", s, ok)
	}
}

func TestMMDBNotFoundAndEmptyTree(t *testing.T) {
	tr := newMMTree(6)
	r := mustOpen(t, tr.build(24, nil)) // a single empty node
	for _, ip := range []string{"1.2.3.4", "::1", "2a02::1", "::ffff:1.2.3.4"} {
		if _, ok := r.find(netip.MustParseAddr(ip)); ok {
			t.Errorf("%s found in an empty tree", ip)
		}
	}
	var nilR *mmdbReader
	if _, ok := nilR.find(netip.MustParseAddr("1.2.3.4")); ok {
		t.Error("nil reader found")
	}
	if _, ok := nilR.lookupString(netip.MustParseAddr("1.2.3.4"), "a"); ok {
		t.Error("nil reader lookupString")
	}
	if nilR.close() != nil {
		t.Error("nil close")
	}
}

func TestMMDBCloseThenLookup(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.mmdb")
	if err := os.WriteFile(p, buildGeoDB(t, 24, 6, 0), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := openMMDB(p)
	if err != nil {
		t.Fatal(err)
	}
	ip := netip.MustParseAddr("81.2.69.10")
	if s, ok := r.lookupString(ip, "country", "iso_code"); !ok || s != "GB" {
		t.Fatalf("before close: %q %v", s, ok)
	}
	if err := r.close(); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.lookupString(ip, "country", "iso_code"); ok {
		t.Fatal("lookup after close must miss (not touch unmapped memory)")
	}
	if err := r.close(); err != nil { // idempotent
		t.Fatal(err)
	}
}

func TestMMDBRejectsBadMetadata(t *testing.T) {
	good := buildGeoDB(t, 24, 6, 0)
	if _, err := newMMDB(nil); err == nil {
		t.Error("nil accepted")
	}
	if _, err := newMMDB([]byte("not an mmdb")); err == nil {
		t.Error("garbage accepted")
	}
	// marker present, metadata garbage
	if _, err := newMMDB([]byte("xxxx" + mmdbMetaMarker + "\xff\xff\xff")); err == nil {
		t.Error("garbage metadata accepted")
	}
	// record_size 24 -> 25 and ip_version 6 -> 5: same encoded length, invalid values.
	badRec := append([]byte{}, good...)
	badIP := append([]byte{}, good...)
	i := bytes.Index(badRec, []byte("record_size"))
	badRec[i+len("record_size")+1] = 25 // ctrl byte is at +0 (uint16, size 1), value at +1
	j := bytes.Index(badIP, []byte("ip_version"))
	badIP[j+len("ip_version")+1] = 5
	if _, err := newMMDB(badRec); err == nil {
		t.Error("record_size 25 accepted")
	}
	if _, err := newMMDB(badIP); err == nil {
		t.Error("ip_version 5 accepted")
	}
}

// Every truncation and many random corruptions of valid databases (ours and the checked-in fixtures) must be
// handled without a panic; a database that still opens must answer lookups without a panic too.
func TestMMDBTruncatedAndCorruptNeverPanics(t *testing.T) {
	var seeds [][]byte
	seeds = append(seeds, buildGeoDB(t, 24, 6, 0), buildGeoDB(t, 28, 4, 0), buildGeoDB(t, 32, 6, 0))
	for _, f := range []string{"country.mmdb", "city.mmdb"} {
		b, err := os.ReadFile(filepath.Join("testdata", f))
		if err != nil {
			t.Fatal(err)
		}
		seeds = append(seeds, b)
	}
	ips := []netip.Addr{
		netip.MustParseAddr("81.2.69.10"), netip.MustParseAddr("2a02:6b8::5"), netip.MustParseAddr("1.2.3.4"),
		netip.MustParseAddr("89.160.20.5"), netip.MustParseAddr("::1"), netip.MustParseAddr("8.8.8.8"),
	}
	probe := func(b []byte) {
		r, err := newMMDB(b)
		if err != nil {
			return
		}
		for _, ip := range ips {
			r.lookupString(ip, "country", "iso_code")
			r.lookupString(ip, "city", "names", "en")
			if off, ok := r.find(ip); ok {
				_, _, _ = r.data.decode(off, 0)
			}
		}
	}
	rng := rand.New(rand.NewSource(7))
	for _, s := range seeds {
		// every truncation length (stride keeps big seeds fast)
		step := 1 + len(s)/4000
		for n := 0; n < len(s); n += step {
			probe(s[:n])
		}
		for i := 0; i < 1500; i++ {
			b := append([]byte(nil), s...)
			for k := 0; k < 1+rng.Intn(6); k++ {
				b[rng.Intn(len(b))] = byte(rng.Intn(256))
			}
			probe(b)
		}
	}
}

// The checked-in fixtures are real MaxMind-format files: pin concrete answers (the golden spec shared with
// the geo tests) and confirm the reader sees them as the expected shape.
func TestMMDBFixtures(t *testing.T) {
	for _, f := range []string{"country.mmdb", "city.mmdb"} {
		r, err := openMMDB(filepath.Join("testdata", f))
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if r.ipVersion != 6 || r.recBits != 24 {
			t.Errorf("%s: ip=%d rec=%d", f, r.ipVersion, r.recBits)
		}
		for ip, want := range map[string]string{"81.2.69.10": "GB", "89.160.20.5": "SE", "2a02:6b8::5": "DE", "8.8.8.8": ""} {
			if f == "city.mmdb" && ip != "81.2.69.10" {
				continue
			}
			if got := str(r, ip, "country", "iso_code"); got != want {
				t.Errorf("%s %s = %q want %q", f, ip, got, want)
			}
		}
		if f == "city.mmdb" {
			if got := str(r, "81.2.69.10", "city", "names", "en"); got != "London" {
				t.Errorf("city = %q", got)
			}
		}
		_ = r.close()
	}
}

// End to end through geo.lookup (ISO normalisation, city cleaning) on a generated city database.
func TestGeoLookupOnGeneratedCityDB(t *testing.T) {
	p := filepath.Join(t.TempDir(), "gen.mmdb")
	if err := os.WriteFile(p, buildGeoDB(t, 28, 6, 0), 0o644); err != nil {
		t.Fatal(err)
	}
	g := openGeo(p)
	if g == nil {
		t.Fatal("generated DB should open")
	}
	defer g.close()
	for in, want := range map[string][2]string{
		"81.2.69.142":      {"GB", "Boxford"},
		"[2a02:6b8::5]:80": {"DE", "Berlin"},
		"89.160.20.1:8080": {"SE", "Linköping"},
		"1.1.1.1":          {"AU", ""},
		"::ffff:81.2.69.1": {"GB", "London"},
		"192.168.0.1":      {"", ""},
		"8.8.8.8":          {"", ""},
	} {
		cc, city := g.lookup(in, true)
		if cc != want[0] || city != want[1] {
			t.Errorf("lookup(%q) = %q,%q want %q,%q", in, cc, city, want[0], want[1])
		}
		if cc2, c2 := g.lookup(in, false); cc2 != want[0] || c2 != "" {
			t.Errorf("lookup(%q,false) = %q,%q", in, cc2, c2)
		}
	}
}

// A crafted file can point a wrong-typed value at a pointer graph that fans out at every level. A string
// lookup must reject it after the header, never expand it.
func TestMMDBStringLookupDoesNotExpandPointerGraph(t *testing.T) {
	const levels, lvlSize = 28, 13
	var b []byte
	for i := 0; i < levels; i++ {
		next := (i + 1) * lvlSize
		b = append(b, 0xE3) // map, 3 entries
		for _, k := range []byte{'a', 'b', 'c'} {
			b = append(b, 0x41, k, 0x20|byte(next>>8&7), byte(next))
		}
	}
	b = append(b, 0x41, 'x') // the last level is a plain string
	rec := len(b)
	b = append(b, 0xE1, 0x41, 'k', 0x20, 0x00) // {"k": -> level 0 (a map)}
	d := decoder{b}

	done := make(chan struct{})
	go func() {
		defer close(done)
		if s, ok := d.stringAt(rec, "k"); ok {
			t.Errorf("a map is not a string: got %q", s)
		}
		if _, ok := d.child(rec, "missing"); ok {
			t.Error("unexpected child")
		}
		if off, ok := d.child(rec, "k"); !ok || off < 0 {
			t.Error("child k should resolve")
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("lookup expanded the pointer graph")
	}
}
