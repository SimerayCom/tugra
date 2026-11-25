package seal

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

type vectorFile struct {
	RecipientPrivHex string `json:"recipientPrivHex"`
	RecipientPubB64  string `json:"recipientPubB64"`
	RunID            string `json:"runId"`
	ServerID         string `json:"serverId"`
	Vectors          []struct {
		Name       string `json:"name"`
		Ref        string `json:"ref"`
		Field      string `json:"field"`
		Class      string `json:"class"`
		PlainB64   string `json:"plainB64"`
		EphPrivHex string `json:"ephPrivHex"`
		NonceHex   string `json:"nonceHex"`
		Env        string `json:"env"`
	} `json:"vectors"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile("testdata/tse1-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// open is the hub's side, written for the tests only (this package ships no Open). It follows the layout in the package comment.
func open(priv []byte, runID string, c Context, env string) ([]byte, error) {
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(env, Prefix))
	if err != nil || len(body) < 32+12+16+PadBytes {
		return nil, errors.New("short")
	}
	k, err := ecdh.X25519().NewPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	epk, err := ecdh.X25519().NewPublicKey(body[:32])
	if err != nil {
		return nil, err
	}
	shared, err := k.ECDH(epk)
	if err != nil {
		return nil, err
	}
	key, err := hkdf.Key(sha256.New, shared, []byte(runID), HKDFInfo+KeyID(k.PublicKey().Bytes()), 32)
	if err != nil {
		return nil, err
	}
	blk, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(blk)
	aad, err := AAD(c)
	if err != nil {
		return nil, err
	}
	framed, err := g.Open(nil, body[32:44], body[44:], aad)
	if err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(framed)
	if int(n) > len(framed)-4 {
		return nil, errors.New("bad length")
	}
	return framed[4 : 4+n], nil
}

// A fixed envelope made by an independent Node implementation: Go must produce the same bytes, and open them.
func TestNodeVectorsByteForByte(t *testing.T) {
	v := loadVectors(t)
	pub, err := ParseRecipient(v.RecipientPubB64)
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := hex.DecodeString(v.RecipientPrivHex)
	for _, c := range v.Vectors {
		t.Run(c.Name, func(t *testing.T) {
			eph, _ := hex.DecodeString(c.EphPrivHex)
			nonce, _ := hex.DecodeString(c.NonceHex)
			plain, _ := base64.StdEncoding.DecodeString(c.PlainB64)
			ctx := Context{RunID: v.RunID, ServerID: v.ServerID, Ref: c.Ref, Field: c.Field, Class: c.Class}
			got, err := Seal(bytes.NewReader(append(eph, nonce...)), pub, ctx, plain)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.Env {
				t.Fatalf("envelope differs from the Node vector:\n got %s\nwant %s", got, c.Env)
			}
			back, err := open(priv, v.RunID, ctx, c.Env)
			if err != nil || !bytes.Equal(back, plain) {
				t.Fatalf("Go cannot open the Node envelope: %v", err)
			}
		})
	}
}

func TestAADSwapFails(t *testing.T) {
	v := loadVectors(t)
	priv, _ := hex.DecodeString(v.RecipientPrivHex)
	c := v.Vectors[0]
	ok := Context{RunID: v.RunID, ServerID: v.ServerID, Ref: c.Ref, Field: c.Field, Class: c.Class}
	if _, err := open(priv, v.RunID, ok, c.Env); err != nil {
		t.Fatal(err)
	}
	swaps := map[string]Context{
		"run":    {RunID: "run-0002", ServerID: ok.ServerID, Ref: ok.Ref, Field: ok.Field, Class: ok.Class},
		"server": {RunID: ok.RunID, ServerID: "srv-0002", Ref: ok.Ref, Field: ok.Field, Class: ok.Class},
		"ref":    {RunID: ok.RunID, ServerID: ok.ServerID, Ref: "env:other", Field: ok.Field, Class: ok.Class},
		"field":  {RunID: ok.RunID, ServerID: ok.ServerID, Ref: ok.Ref, Field: "other", Class: ok.Class},
		"class":  {RunID: ok.RunID, ServerID: ok.ServerID, Ref: ok.Ref, Field: ok.Field, Class: "s3"},
	}
	for name, ctx := range swaps {
		if _, err := open(priv, ctx.RunID, ctx, c.Env); err == nil {
			t.Errorf("an envelope moved to another %s must not open", name)
		}
	}
	// A different run id with the right context also changes the HKDF salt.
	if _, err := open(priv, "run-0002", ok, c.Env); err == nil {
		t.Error("wrong salt must not open")
	}
}

func TestTamperedEnvelopeFails(t *testing.T) {
	v := loadVectors(t)
	priv, _ := hex.DecodeString(v.RecipientPrivHex)
	c := v.Vectors[0]
	ctx := Context{RunID: v.RunID, ServerID: v.ServerID, Ref: c.Ref, Field: c.Field, Class: c.Class}
	body, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(c.Env, Prefix))
	for _, i := range []int{0, 31, 32, 44, len(body) - 1} {
		b := append([]byte(nil), body...)
		b[i] ^= 1
		if _, err := open(priv, v.RunID, ctx, Prefix+base64.RawURLEncoding.EncodeToString(b)); err == nil {
			t.Errorf("flipping byte %d must fail", i)
		}
	}
}

func TestRandomSealRoundTripAndForwardSecrecyShape(t *testing.T) {
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	ctx := Context{RunID: "r", ServerID: "s", Ref: "env:x", Field: "value", Class: "env"}
	secret := []byte("super-secret-value")
	a, err := Seal(rand.Reader, rk.PublicKey().Bytes(), ctx, secret)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := Seal(rand.Reader, rk.PublicKey().Bytes(), ctx, secret)
	if a == b {
		t.Fatal("two seals of the same value must differ (fresh ephemeral key and nonce)")
	}
	if !strings.HasPrefix(a, Prefix) || strings.Contains(a, "super-secret") {
		t.Fatalf("bad envelope %q", a)
	}
	got, err := open(rk.Bytes(), "r", ctx, a)
	if err != nil || string(got) != string(secret) {
		t.Fatalf("round trip: %v", err)
	}
	// Padding hides the length: values of 1 and 50 bytes give the same envelope size.
	s1, _ := Seal(rand.Reader, rk.PublicKey().Bytes(), ctx, []byte("a"))
	s2, _ := Seal(rand.Reader, rk.PublicKey().Bytes(), ctx, bytes.Repeat([]byte("a"), 50))
	if len(s1) != len(s2) {
		t.Fatalf("padding: %d vs %d", len(s1), len(s2))
	}
}

func TestRecipientValidation(t *testing.T) {
	good, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := ParseRecipient(base64.StdEncoding.EncodeToString(good.PublicKey().Bytes())); err != nil {
		t.Fatalf("good key refused: %v", err)
	}
	zero := make([]byte, 32)
	one := make([]byte, 32)
	one[0] = 1
	// u = 0, u = 1 and the other small-order points (order 8, and the non-canonical encodings) all give an all-zero shared secret.
	small := [][]byte{zero, one}
	for _, h := range []string{
		"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
		"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	} {
		b, _ := hex.DecodeString(h)
		small = append(small, b)
	}
	for i, p := range small {
		if _, err := ParseRecipient(base64.StdEncoding.EncodeToString(p)); err == nil {
			t.Errorf("small-order point %d accepted", i)
		}
	}
	for _, bad := range []string{"", "not base64!", base64.StdEncoding.EncodeToString(make([]byte, 31)), base64.StdEncoding.EncodeToString(make([]byte, 33))} {
		if _, err := ParseRecipient(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestContextAndSizeLimits(t *testing.T) {
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub := rk.PublicKey().Bytes()
	good := Context{RunID: "r", ServerID: "s", Ref: "env:x", Field: "value", Class: "env"}
	for _, bad := range []Context{{}, {RunID: "r"}, {RunID: "r", ServerID: "s", Ref: "env:x", Field: "va\x00lue", Class: "env"}} {
		if _, err := Seal(rand.Reader, pub, bad, []byte("x")); !errors.Is(err, ErrContext) {
			t.Errorf("context %+v: %v", bad, err)
		}
	}
	if _, err := Seal(rand.Reader, pub, good, make([]byte, MaxValue+1)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("too large: %v", err)
	}
	if _, err := Seal(rand.Reader, pub, good, make([]byte, MaxValue)); err != nil {
		t.Errorf("max value: %v", err)
	}
}

// Go seals, Node opens: the same envelope must open under Node's crypto (skipped where node is not installed).
func TestNodeOpensGoEnvelope(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	ctx := Context{RunID: "run-x", ServerID: "srv-x", Ref: "database:db1", Field: "postgres_password", Class: "db_credentials"}
	plain := []byte("pässwörd\n\"quoted\"")
	env, err := Seal(rand.Reader, rk.PublicKey().Bytes(), ctx, plain)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "testdata/open.mjs")
	cmd.Stdin = strings.NewReader(strings.Join([]string{hex.EncodeToString(rk.Bytes()), ctx.RunID, ctx.ServerID, ctx.Ref, ctx.Field, ctx.Class, env}, "\n"))
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node could not open the Go envelope: %v", err)
	}
	if got, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(string(out))); !bytes.Equal(got, plain) {
		t.Fatalf("node opened a different value: %q", got)
	}
}
