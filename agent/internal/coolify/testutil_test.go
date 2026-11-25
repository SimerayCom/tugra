package coolify

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/coolify/open"
	"github.com/SimerayCom/tugra/agent/internal/coolify/seal"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// ---- Laravel-format encryption (test only): the same wire format PHP writes, so the fixtures need no framework -------------------

func laravelEncryptCBC(t testing.TB, key []byte, plain []byte) string {
	t.Helper()
	iv := make([]byte, 16)
	_, _ = rand.Read(iv)
	pad := 16 - len(plain)%16
	buf := append(append([]byte(nil), plain...), bytes.Repeat([]byte{byte(pad)}, pad)...)
	blk, _ := aes.NewCipher(key)
	cipher.NewCBCEncrypter(blk, iv).CryptBlocks(buf, buf)
	ivB, valB := base64.StdEncoding.EncodeToString(iv), base64.StdEncoding.EncodeToString(buf)
	h := hmac.New(sha256.New, key)
	h.Write([]byte(ivB + valB))
	j, _ := json.Marshal(map[string]string{"iv": ivB, "value": valB, "mac": hex.EncodeToString(h.Sum(nil)), "tag": ""})
	return base64.StdEncoding.EncodeToString(j)
}

func phpSerialize(s string) []byte { return []byte("s:" + strconv.Itoa(len(s)) + ":\"" + s + "\";") }

// ---- a fake Coolify host: psql, the app key and the helper container --------------------------------------------------------------

type fakeHost struct {
	mu          sync.Mutex
	tables      map[string]map[string]map[string]*string // table -> id -> column -> stored text (nil = NULL; a missing column = not in the schema)
	missing     map[string]bool                          // tables this "version" does not have
	appKey      string
	prevKeys    string
	argvs       [][]string
	psqlSQL     []string
	helperIn    bytes.Buffer // everything written to the helper's stdin
	helperErr   bytes.Buffer // everything the helper wrote to stderr
	helperHook  func()       // called when the helper starts (tests block or flip state here)
	runs        int
	failHelper  bool
	helperTrash string // when set, the fake helper prints this extra stdout line before its real output
	rnd         io.Reader
}

func newFakeHost(appKey string) *fakeHost {
	return &fakeHost{tables: map[string]map[string]map[string]*string{}, missing: map[string]bool{}, appKey: appKey, rnd: rand.Reader}
}

func (h *fakeHost) put(table, id, col string, v *string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.tables[table] == nil {
		h.tables[table] = map[string]map[string]*string{}
	}
	if h.tables[table][id] == nil {
		h.tables[table][id] = map[string]*string{}
	}
	h.tables[table][id][col] = v
}

func sp(s string) *string { return &s }

var (
	sqlTableRe = regexp.MustCompile(`from (\w+) t where`)
	sqlIDsRe   = regexp.MustCompile(`in \(([^)]*)\)`)
	sqlColRe   = regexp.MustCompile(`'(\w+)', json_build_object\('p'`)
)

func (h *fakeHost) run(ctx context.Context, argv []string, stdin io.Reader, stdout, stderr io.Writer) error {
	h.mu.Lock()
	h.argvs = append(h.argvs, append([]string(nil), argv...))
	h.runs++
	h.mu.Unlock()
	if len(argv) < 2 || argv[0] != "docker" {
		return fmt.Errorf("not docker")
	}
	switch argv[1] {
	case "rm":
		return nil
	case "exec":
		if contains(argv, "coolify-db") {
			return h.psql(stdin, stdout)
		}
		_, err := io.WriteString(stdout, h.appKey+"\n"+h.prevKeys+"\n")
		return err
	case "run":
		return h.helper(ctx, argv, stdin, stdout, stderr)
	}
	return fmt.Errorf("unexpected command")
}

func (h *fakeHost) psql(stdin io.Reader, stdout io.Writer) error {
	raw, _ := io.ReadAll(stdin)
	sql := string(raw)
	h.mu.Lock()
	h.psqlSQL = append(h.psqlSQL, sql)
	h.mu.Unlock()
	tm := sqlTableRe.FindStringSubmatch(sql)
	im := sqlIDsRe.FindStringSubmatch(sql)
	if tm == nil || im == nil {
		return fmt.Errorf("bad sql")
	}
	if h.missing[tm[1]] {
		return fmt.Errorf("relation does not exist")
	}
	if strings.Contains(sql, "is_git_related") && !strings.Contains(sql, "t.is_git_related is true") {
		return fmt.Errorf("guard mangled")
	}
	var cols []string
	for _, c := range sqlColRe.FindAllStringSubmatch(sql, -1) {
		cols = append(cols, c[1])
	}
	for _, lit := range strings.Split(im[1], ",") {
		id := strings.Trim(lit, "'")
		row, ok := h.tables[tm[1]][id]
		if !ok {
			continue
		}
		f := map[string]any{}
		for _, c := range cols {
			v, has := row[c]
			cell := map[string]any{"p": has}
			if has {
				if v == nil {
					cell["v"] = nil
				} else {
					cell["v"] = *v
				}
			} else {
				cell["v"] = nil
			}
			f[c] = cell
		}
		b, _ := json.Marshal(map[string]any{"ref": id, "f": f})
		stdout.Write(append(b, '\n'))
	}
	return nil
}

// helper runs the real coolify-open code in-process, the way the container would: key line and rows on stdin, records on stdout.
func (h *fakeHost) helper(ctx context.Context, argv []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if h.helperHook != nil {
		h.helperHook()
	}
	i := indexOf(argv, "coolify-open")
	if i < 0 {
		return fmt.Errorf("no helper subcommand")
	}
	if h.failHelper {
		return fmt.Errorf("exit status 125")
	}
	tee := io.TeeReader(stdin, &h.helperIn)
	var eb bytes.Buffer
	if h.helperTrash != "" {
		io.WriteString(stdout, h.helperTrash+"\n")
	}
	code := open.Run(argv[i+1:], tee, stdout, &eb, h.rnd)
	h.mu.Lock()
	h.helperErr.Write(eb.Bytes())
	h.mu.Unlock()
	_, _ = io.Copy(stderr, &eb)
	if code != 0 {
		return fmt.Errorf("exit status %d", code)
	}
	return nil
}

func indexOf(a []string, s string) int {
	for i, x := range a {
		if x == s {
			return i
		}
	}
	return -1
}

// ---- gate harness ---------------------------------------------------------------------------------------------------------------

type harness struct {
	t      *testing.T
	host   *fakeHost
	gate   *Gate
	hubPub ed25519.PublicKey
	hubKey ed25519.PrivateKey
	caps   map[string]bool
	capMu  sync.Mutex
	sent   []protocol.CoolifySecretsResult
	frames [][]byte // every frame sent, as JSON
	logs   bytes.Buffer
	now    time.Time
	state  *State
	rk     *ecdh.PrivateKey
	n      int
}

func newHarness(t *testing.T, host *fakeHost) *harness {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	rk, _ := ecdh.X25519().GenerateKey(rand.Reader)
	h := &harness{t: t, host: host, hubPub: pub, hubKey: priv, caps: map[string]bool{"coolify_secrets": true}, now: time.Unix(1_800_000_000, 0), state: NewState(), rk: rk}
	h.gate = NewGate(Config{
		ServerID: "srv-1", AgentImage: "ghcr.io/example/agent:1.0", HubPub: pub,
		Allows: func(c string) bool { h.capMu.Lock(); defer h.capMu.Unlock(); return h.caps[c] },
		Send: func(v any) error {
			b, _ := json.Marshal(v)
			h.capMu.Lock()
			h.frames = append(h.frames, b)
			if r, ok := v.(protocol.CoolifySecretsResult); ok {
				h.sent = append(h.sent, r)
			}
			h.capMu.Unlock()
			return nil
		},
		Now: func() time.Time { return h.now }, Run: host.run, Rand: rand.Reader, State: h.state,
		Logf: func(f string, a ...any) { h.capMu.Lock(); fmt.Fprintf(&h.logs, f+"\n", a...); h.capMu.Unlock() },
	})
	return h
}

func (h *harness) setCap(c string, on bool) { h.capMu.Lock(); h.caps[c] = on; h.capMu.Unlock() }

func (h *harness) recipientB64() string {
	return base64.StdEncoding.EncodeToString(h.rk.PublicKey().Bytes())
}

// frame builds a correctly signed request; tweak mutates it BEFORE signing, so a test can build any valid-but-odd frame.
func (h *harness) frame(classes, refs []string, tweak func(*protocol.ServerMsg)) protocol.ServerMsg {
	h.n++
	m := protocol.ServerMsg{
		Type: "coolify_secrets_req", ReqID: fmt.Sprintf("req-%d", h.n), RunID: "run-1", Classes: classes, Refs: refs,
		RecipientKey: h.recipientB64(), Exp: h.now.Unix() + 300, Capability: "coolify_secrets",
	}
	if tweak != nil {
		tweak(&m)
	}
	h.sign(&m)
	return m
}

func (h *harness) sign(m *protocol.ServerMsg) {
	f := protocol.CoolifySecretsFields{ServerID: "srv-1", ReqID: m.ReqID, RunID: m.RunID, Classes: m.Classes, Refs: m.Refs, RecipientKey: m.RecipientKey, Exp: m.Exp, Capability: m.Capability}
	m.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(h.hubKey, []byte(protocol.CanonicalCoolifySecrets(f))))
}

func (h *harness) send(m protocol.ServerMsg) []protocol.CoolifySecretsResult {
	h.t.Helper()
	h.capMu.Lock()
	before := len(h.sent)
	h.capMu.Unlock()
	h.gate.Handle(context.Background(), m)
	h.gate.Wait()
	h.capMu.Lock()
	defer h.capMu.Unlock()
	return append([]protocol.CoolifySecretsResult(nil), h.sent[before:]...)
}

// openRecords opens every sealed record with the run's private key (the hub's job) and returns ref|field -> plaintext, plus the codes.
func (h *harness) openRecords(rs []protocol.CoolifySecretsResult) (plain map[string]string, codes map[string]string) {
	h.t.Helper()
	plain, codes = map[string]string{}, map[string]string{}
	for _, r := range rs {
		for _, rec := range r.Records {
			k := rec.Ref + "|" + rec.Field
			if rec.Env == "" {
				codes[k] = rec.Code
				continue
			}
			p, err := openEnvelope(h.rk, "run-1", "srv-1", rec, rec.Env)
			if err != nil {
				h.t.Fatalf("cannot open %s: %v", k, err)
			}
			plain[k] = p
		}
	}
	return
}

func openEnvelope(rk *ecdh.PrivateKey, runID, serverID string, rec protocol.CoolifySecretRecord, env string) (string, error) {
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(env, seal.Prefix))
	if err != nil || len(body) < 32+12+16 {
		return "", fmt.Errorf("short")
	}
	epk, err := ecdh.X25519().NewPublicKey(body[:32])
	if err != nil {
		return "", err
	}
	shared, err := rk.ECDH(epk)
	if err != nil {
		return "", err
	}
	key, err := hkdfKey(shared, runID, seal.KeyID(rk.PublicKey().Bytes()))
	if err != nil {
		return "", err
	}
	blk, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(blk)
	aad, _ := seal.AAD(seal.Context{RunID: runID, ServerID: serverID, Ref: rec.Ref, Field: rec.Field, Class: rec.Class})
	framed, err := g.Open(nil, body[32:44], body[44:], aad)
	if err != nil {
		return "", err
	}
	n := int(uint32(framed[0])<<24 | uint32(framed[1])<<16 | uint32(framed[2])<<8 | uint32(framed[3]))
	return string(framed[4 : 4+n]), nil
}

func sign(h *harness, canonical string) []byte { return ed25519Sign(h.hubKey, canonical) }
