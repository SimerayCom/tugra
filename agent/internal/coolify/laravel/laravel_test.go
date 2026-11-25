package laravel

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

type vector struct {
	Name     string   `json:"name"`
	Key      string   `json:"key"`
	Prev     []string `json:"prev"`
	Payload  string   `json:"payload"`
	PlainB64 string   `json:"plainB64"`
	Form     string   `json:"form"`
	Cipher   string   `json:"cipher"`
	Code     string   `json:"code"`
	ViaPrev  bool     `json:"viaPrev"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("testdata/php-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v []vector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v) < 20 {
		t.Fatalf("expected the full PHP vector set, got %d", len(v))
	}
	return v
}

func formOf(s string) Form {
	if s == "serialized" {
		return FormSerialized
	}
	return FormString
}

// Every vector was produced by PHP's openssl in Laravel's wire format (see testdata/gen-php-vectors.php).
func TestPHPVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			ring := ParseKeyRing(v.Key, strings.Join(v.Prev, ","))
			res, err := ring.Open(v.Payload, formOf(v.Form), false)
			if v.Code != "" {
				if err == nil {
					t.Fatalf("expected %s, opened %q", v.Code, res.Plain)
				}
				if CodeOf(err) != v.Code {
					t.Fatalf("code = %s, want %s", CodeOf(err), v.Code)
				}
				if err.Error() != v.Code {
					t.Fatalf("error text must be the bare code, got %q", err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			want, _ := base64.StdEncoding.DecodeString(v.PlainB64)
			if string(res.Plain) != string(want) {
				t.Fatalf("plaintext mismatch (%d vs %d bytes)", len(res.Plain), len(want))
			}
			if res.UsedPrevious != v.ViaPrev {
				t.Fatalf("UsedPrevious = %v, want %v", res.UsedPrevious, v.ViaPrev)
			}
		})
	}
}

func goodVector(t *testing.T) vector {
	t.Helper()
	for _, v := range loadVectors(t) {
		if v.Name == "cbc256-string-simple" {
			return v
		}
	}
	t.Fatal("vector missing")
	return vector{}
}

func TestKeyProblems(t *testing.T) {
	v := goodVector(t)
	if _, err := ParseKeyRing("", "").Open(v.Payload, FormString, false); CodeOf(err) != CodeNoKey {
		t.Fatalf("empty key: %v", err)
	}
	if _, err := ParseKeyRing("base64:"+base64.StdEncoding.EncodeToString([]byte("short")), "").Open(v.Payload, FormString, false); CodeOf(err) != CodeUnsupportedCipher {
		t.Fatalf("short key: %v", err)
	}
	if _, err := ParseKeyRing("base64:!!!notbase64", "").Open(v.Payload, FormString, false); CodeOf(err) != CodeUnsupportedCipher {
		t.Fatalf("bad base64 key: %v", err)
	}
	// A quoted .env value works.
	if _, err := ParseKeyRing(`"`+v.Key+`"`, "").Open(v.Payload, FormString, false); err != nil {
		t.Fatalf("quoted key: %v", err)
	}
	// Zero wipes the key.
	r := ParseKeyRing(v.Key, "")
	r.Zero()
	if _, err := r.Open(v.Payload, FormString, false); CodeOf(err) != CodeBadMAC {
		t.Fatalf("zeroed ring must not open: %v", err)
	}
}

func TestPlaintextRowsBeforeFourPointFive(t *testing.T) {
	v := goodVector(t)
	r := ParseKeyRing(v.Key, "")
	// An unencrypted stored value, on a column that may hold one: returned as it is, and flagged.
	res, err := r.Open("whsec_plain_value", FormString, true)
	if err != nil || string(res.Plain) != "whsec_plain_value" || !res.WasPlaintext {
		t.Fatalf("plain row: %v %+v", err, res)
	}
	// The same value on a column that may not: refused (a truncated ciphertext must never pass as the secret).
	if _, err := r.Open("whsec_plain_value", FormString, false); CodeOf(err) != CodeBadPayload {
		t.Fatalf("strict column: %v", err)
	}
	// A Laravel-shaped value with a wrong MAC stays bad_mac even on a plaintext-tolerant column.
	bad := tamperMAC(t, v.Payload)
	if _, err := r.Open(bad, FormString, true); CodeOf(err) != CodeBadMAC {
		t.Fatalf("shaped but forged must be bad_mac: %v", err)
	}
	// Truncated base64 of a real payload is not shaped: tolerated only where plaintext is allowed.
	if _, err := r.Open(v.Payload[:len(v.Payload)/2], FormString, false); err == nil {
		t.Fatal("truncated payload must fail on a strict column")
	}
}

func tamperMAC(t *testing.T, p string) string {
	t.Helper()
	raw, _ := base64.StdEncoding.DecodeString(p)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	m["mac"] = strings.Repeat("a", 64)
	out, _ := json.Marshal(m)
	return base64.StdEncoding.EncodeToString(out)
}

func TestTooLarge(t *testing.T) {
	r := ParseKeyRing(goodVector(t).Key, "")
	if _, err := r.Open(strings.Repeat("A", MaxPayloadBytes+1), FormString, true); CodeOf(err) != CodeTooLarge {
		t.Fatalf("too large: %v", err)
	}
}

func TestSerializedShapes(t *testing.T) {
	ok := map[string]string{
		`s:3:"abc";`:          "abc",
		`s:0:"";`:             "",
		"s:7:\"a\";\"b\n;\";": "a\";\"b\n;",
		`s:3:"é1";`:           "é1", // byte length, not characters
	}
	for in, want := range ok {
		got, err := unwrapSerialized([]byte(in))
		if err != nil || string(got) != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	unsupported := []string{`O:8:"stdClass":0:{}`, `a:1:{i:0;s:1:"a";}`, `C:3:"Foo":0:{}`, `b:1;`, `i:5;`, `d:1.5;`, `N;`, `E:3:"a:b";`}
	for _, in := range unsupported {
		if _, err := unwrapSerialized([]byte(in)); CodeOf(err) != CodeUnsupportedSerialization {
			t.Errorf("%q: %v", in, err)
		}
	}
	malformed := []string{``, `s`, `s:`, `s:3`, `s:3:"abc"`, `s:3:"abc";x`, `s:4:"abc";`, `s:2:"abc";`, `s:03:"abc";`, `s:-1:"";`, `s:3:abc;`, `s:99999999999:"a";`, `x:1:"a";`, "plain value"}
	for _, in := range malformed {
		if _, err := unwrapSerialized([]byte(in)); CodeOf(err) != CodeBadPayload {
			t.Errorf("%q: %v", in, err)
		}
	}
	// A serialized string that holds another serialized shape is still just a string: nothing is unwrapped twice.
	got, err := unwrapSerialized([]byte(`s:15:"O:8:"stdClass";";`))
	if err != nil || string(got) != `O:8:"stdClass";` {
		t.Errorf("nested: %q %v", got, err)
	}
}

func TestFormAuto(t *testing.T) {
	if v, err := finish([]byte(`s:3:"abc";`), FormAuto); err != nil || string(v) != "abc" {
		t.Fatalf("auto serialized: %q %v", v, err)
	}
	if v, err := finish([]byte("a:b"), FormAuto); err != nil || string(v) != "a:b" {
		t.Fatalf("auto raw looks like a prefix: %q %v", v, err)
	}
}

// Fuzzing: the parser must never panic, and a value it refuses carries only a known code.
func FuzzOpen(f *testing.F) {
	for _, s := range []string{"", "e30=", "eyJpdiI6IiIsInZhbHVlIjoiIiwibWFjIjoiIn0=", "not base64 at all", strings.Repeat("A", 4096)} {
		f.Add(s, uint8(0), true)
	}
	if raw, err := os.ReadFile("testdata/php-vectors.json"); err == nil {
		var vs []vector
		if json.Unmarshal(raw, &vs) == nil {
			for _, v := range vs {
				f.Add(v.Payload, uint8(1), false)
			}
		}
	}
	ring := ParseKeyRing("base64:"+base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))), "base64:"+base64.StdEncoding.EncodeToString([]byte(strings.Repeat("p", 16))))
	known := map[string]bool{CodeBadMAC: true, CodeBadPayload: true, CodeNoKey: true, CodeUnsupportedCipher: true, CodeUnsupportedSerialization: true, CodeTooLarge: true}
	f.Fuzz(func(t *testing.T, s string, form uint8, plainOK bool) {
		_, err := ring.Open(s, Form(form%3), plainOK)
		if err != nil && !known[CodeOf(err)] {
			t.Fatalf("unknown code %q", CodeOf(err))
		}
	})
}

func FuzzSerialized(f *testing.F) {
	for _, s := range []string{`s:3:"abc";`, `O:1:"A":0:{}`, `s:`, "s:5:\"\x00\xff\";"} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		v, ok := parseSerializedString(b)
		if ok && len(v)+len(strconv.Itoa(len(v)))+6 != len(b) {
			t.Fatalf("accepted a string whose length does not match: %q", b)
		}
		_, _ = unwrapSerialized(b)
	})
}
