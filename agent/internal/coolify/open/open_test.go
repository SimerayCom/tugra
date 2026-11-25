package open

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func phpVectors(t *testing.T) []struct {
	Name, Key, Payload, PlainB64, Form, Code string
	Prev                                     []string
	ViaPrev                                  bool
} {
	t.Helper()
	raw, err := os.ReadFile("../laravel/testdata/php-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v []struct {
		Name, Key, Payload, PlainB64, Form, Code string
		Prev                                     []string
		ViaPrev                                  bool
	}
	// field names in the file are lower camel; map them through a generic decode
	var gen []map[string]any
	if err := json.Unmarshal(raw, &gen); err != nil {
		t.Fatal(err)
	}
	for _, g := range gen {
		e := struct {
			Name, Key, Payload, PlainB64, Form, Code string
			Prev                                     []string
			ViaPrev                                  bool
		}{}
		e.Name, _ = g["name"].(string)
		e.Key, _ = g["key"].(string)
		e.Payload, _ = g["payload"].(string)
		e.PlainB64, _ = g["plainB64"].(string)
		e.Form, _ = g["form"].(string)
		e.Code, _ = g["code"].(string)
		e.ViaPrev, _ = g["viaPrev"].(bool)
		if ps, ok := g["prev"].([]any); ok {
			for _, p := range ps {
				e.Prev = append(e.Prev, p.(string))
			}
		}
		v = append(v, e)
	}
	return v
}

func run(t *testing.T, recipient []byte, key, prev string, rows []Row) ([]Out, string, int) {
	t.Helper()
	var in bytes.Buffer
	kl, _ := json.Marshal(KeyLine{Key: key, Prev: prev})
	in.Write(kl)
	in.WriteByte('\n')
	for _, r := range rows {
		b, _ := json.Marshal(r)
		in.Write(b)
		in.WriteByte('\n')
	}
	var out, errb bytes.Buffer
	code := Run([]string{"--run=run1", "--server=srv1", "--recipient=" + base64.StdEncoding.EncodeToString(recipient)}, &in, &out, &errb, rand.Reader)
	var outs []Out
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if l == "" {
			continue
		}
		var o Out
		if err := json.Unmarshal([]byte(l), &o); err != nil {
			t.Fatalf("bad stdout line %q", l)
		}
		outs = append(outs, o)
	}
	return outs, errb.String(), code
}

// Every PHP vector goes through the helper and either comes out sealed or as the expected fixed code, and nothing else is printed.
func TestHelperOverPHPVectors(t *testing.T) {
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	for _, v := range phpVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			outs, stderr, code := run(t, rk.PublicKey().Bytes(), v.Key, strings.Join(v.Prev, ","), []Row{{Ref: "env:r1", Field: "value", Class: "env", Form: v.Form, V: v.Payload}})
			if code != 0 {
				t.Fatalf("exit %d: %s", code, stderr)
			}
			if !Leaky && stderr != "" {
				t.Fatalf("stderr must be empty, got %q", stderr)
			}
			if v.Code != "" {
				if len(outs) != 1 || outs[0].Code != v.Code || outs[0].Env != "" {
					t.Fatalf("outs = %+v, want code %s", outs, v.Code)
				}
				return
			}
			if outs[0].Env == "" || !strings.HasPrefix(outs[0].Env, "tse1.") || outs[0].Code != "" {
				t.Fatalf("not sealed: %+v", outs[0])
			}
			if v.ViaPrev {
				if len(outs) != 2 || outs[1].Code != "key_prev" {
					t.Fatalf("want a key_prev note, got %+v", outs)
				}
			}
			plain, _ := base64.StdEncoding.DecodeString(v.PlainB64)
			if len(plain) > 3 && strings.Contains(outs[0].Env, base64.RawURLEncoding.EncodeToString(plain)) {
				t.Fatal("plaintext visible in envelope")
			}
		})
	}
}

func TestHelperRejectsBadInput(t *testing.T) {
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub := base64.StdEncoding.EncodeToString(rk.PublicKey().Bytes())
	cases := map[string][]string{
		"no args":          {},
		"unknown flag":     {"--run=a", "--server=b", "--recipient=" + pub, "--x=1"},
		"bad run":          {"--run=a b", "--server=b", "--recipient=" + pub},
		"bad recipient":    {"--run=a", "--server=b", "--recipient=AAAA"},
		"small order":      {"--run=a", "--server=b", "--recipient=" + base64.StdEncoding.EncodeToString(make([]byte, 32))},
		"positional value": {"--run=a", "--server=b", "--recipient=" + pub, "secret-on-argv"},
	}
	for name, args := range cases {
		var out, errb bytes.Buffer
		if code := RunCLI(args, strings.NewReader("{}\n"), &out, &errb); code != 2 || out.Len() != 0 {
			t.Errorf("%s: exit %d out %q", name, code, out.String())
		}
	}
	good := []string{"--run=a", "--server=b", "--recipient=" + pub}
	for name, stdin := range map[string]string{
		"empty stdin":    "",
		"bad key line":   "not json\n",
		"unknown field":  `{"key":"x","prev":"","extra":1}` + "\n",
		"bad row":        `{"key":"base64:AAAA","prev":""}` + "\n" + `{"ref":"env:a b","field":"v","class":"env","form":"string","v":"x"}` + "\n",
		"bad form":       `{"key":"base64:AAAA","prev":""}` + "\n" + `{"ref":"env:a","field":"v","class":"env","form":"php","v":"x"}` + "\n",
		"unknown column": `{"key":"base64:AAAA","prev":""}` + "\n" + `{"ref":"env:a","field":"v","class":"env","form":"string","v":"x","z":1}` + "\n",
	} {
		var out, errb bytes.Buffer
		code := RunCLI(good, strings.NewReader(stdin), &out, &errb)
		if code != 2 {
			t.Errorf("%s: exit %d", name, code)
		}
		if strings.Contains(errb.String(), "AAAA") || strings.Contains(errb.String(), `"v":"x"`) {
			t.Errorf("%s: stderr echoes input: %q", name, errb.String())
		}
	}
}

// With no key at all every value is `no_key`, and a missing key never turns into plaintext on stdout.
func TestHelperNoKey(t *testing.T) {
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	v := phpVectors(t)[0]
	outs, _, code := run(t, rk.PublicKey().Bytes(), "", "", []Row{{Ref: "env:r1", Field: "value", Class: "env", Form: "serialized", V: v.Payload}})
	if code != 0 || len(outs) != 1 || outs[0].Code != "no_key" {
		t.Fatalf("%d %+v", code, outs)
	}
}

func TestHelperFuzzRowsDoNotPanic(t *testing.T) {
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	for _, v := range []string{"", "e30=", "eyJpdiI6ImEiLCJ2YWx1ZSI6ImIiLCJtYWMiOiJjIn0=", strings.Repeat("A", 70000), "\x00\xff", "s:3:\"abc\";"} {
		for _, f := range []string{"serialized", "string", "auto"} {
			if _, _, code := run(t, rk.PublicKey().Bytes(), "base64:"+base64.StdEncoding.EncodeToString(make([]byte, 32)), "", []Row{{Ref: "env:r", Field: "v", Class: "env", Form: f, PlainOK: true, V: v}}); code != 0 {
				t.Fatalf("exit %d for %q/%s", code, v, f)
			}
		}
	}
}
