package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	tXfer = "/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1800000000&sig=BBBBBBBBBBBBBBBBBBBBBBBB"
	tSha  = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
)

type fs2Harness struct {
	t       *testing.T
	g       *fs2Gate
	priv    ed25519.PrivateKey
	replies chan protocol.Fs2Result
	launchN atomic.Int32
	seq     atomic.Int32
	nowT    time.Time
}

func newFs2Harness(t *testing.T, caps []string, image string) *fs2Harness {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &fs2Harness{t: t, priv: priv, replies: make(chan protocol.Fs2Result, 32), nowT: time.Unix(1_700_000_000, 0)}
	cfg := config.Config{HubURL: "ws://hub-api:3000/agent", AgentImage: image}
	g := newFs2Gate(cfg, pub, newCapState(caps, false), func(v any) error {
		h.replies <- v.(protocol.Fs2Result)
		return nil
	})
	g.state = newFs2State()
	g.now = func() time.Time { return h.nowT }
	g.launch = func(ctx context.Context, image, volume string, r fsd.Req2, stdin io.Reader, stdout io.Writer) (fsd.Result2, error) {
		h.launchN.Add(1)
		return fsd.Result2{Stat: &protocol.FsStat{Name: "x", Type: "file"}}, nil
	}
	g.get = func(ctx context.Context, origin, path string, size int64) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader("hello")), nil
	}
	g.putFrom = func(ctx context.Context, origin, path string, size int64, produce func(context.Context, io.Writer) error) error {
		return produce(ctx, io.Discard)
	}
	h.g = g
	return h
}

// msg builds a correctly signed request for (scope, op), using the matrix's own signed capability.
func (h *fs2Harness) msg(scope, op string, mut func(*protocol.ServerMsg)) protocol.ServerMsg {
	req := protocol.Fs2RequiredCaps(scope, op)
	capab := ""
	if len(req) > 0 {
		capab = req[len(req)-1]
	}
	m := protocol.ServerMsg{
		Type: "fs2_req", ReqID: "req-" + string(rune('a'+h.seq.Add(1))), Op: op, Scope: scope, Subject: "tugra_appv_c1_data",
		Path: "dir/f.txt", Size: 5, Sha256: tSha, TimeoutMs: 30000, Exp: h.nowT.Unix() + 600, Capability: capab,
	}
	switch op {
	case "write":
		m.Xfer, m.Flags, m.Mode = tXfer, "o", "0644"
	case "read":
		m.Xfer = tXfer
	case "stat", "mkdir", "delete", "chmod", "rename":
		m.Size, m.Sha256 = 0, ""
		if op == "rename" {
			m.Path2 = "dir/g.txt"
		}
		if op == "chmod" {
			m.Mode = "0600"
		}
	}
	if scope == "container" {
		m.Subject, m.Path = "tugra_c1", "/app/f.txt"
	}
	if mut != nil {
		mut(&m)
	}
	h.sign(&m)
	return m
}

func (h *fs2Harness) sign(m *protocol.ServerMsg) {
	f := protocol.Fs2Fields{
		ReqID: m.ReqID, Op: m.Op, Scope: m.Scope, Subject: m.Subject, Path: m.Path, Path2: m.Path2, Mode: m.Mode,
		Flags: m.Flags, Size: m.Size, Sha256: m.Sha256, IfMatch: m.IfMatch, Xfer: m.Xfer, TimeoutMs: m.TimeoutMs,
		Exp: m.Exp, Capability: m.Capability,
	}
	m.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(h.priv, []byte(protocol.CanonicalFs2(f))))
}

func (h *fs2Harness) expectReply() protocol.Fs2Result {
	h.t.Helper()
	select {
	case r := <-h.replies:
		return r
	case <-time.After(3 * time.Second):
		h.t.Fatal("no fs2_result")
		return protocol.Fs2Result{}
	}
}

func (h *fs2Harness) expectSilence() {
	h.t.Helper()
	select {
	case r := <-h.replies:
		h.t.Fatalf("unexpected reply: %+v", r)
	case <-time.After(20 * time.Millisecond):
	}
}

var allFiles = []string{"files", "files_write", "terminal"}

func TestFs2BadSignatureDropped(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	m := h.msg("volume", "stat", nil)
	m.Path = "tampered" // not re-signed
	h.g.handle(context.Background(), m)
	h.expectSilence()
	m2 := h.msg("volume", "stat", nil)
	m2.Sig = ""
	h.g.handle(context.Background(), m2)
	h.expectSilence()
	if h.launchN.Load() != 0 {
		t.Fatal("helper launched for an unsigned request")
	}
}

func TestFs2EveryFieldTamperDetected(t *testing.T) {
	base := func(h *fs2Harness) protocol.ServerMsg { return h.msg("volume", "write", nil) }
	muts := map[string]func(*protocol.ServerMsg){
		"reqId":   func(m *protocol.ServerMsg) { m.ReqID += "x" },
		"op":      func(m *protocol.ServerMsg) { m.Op = "mkdir" },
		"scope":   func(m *protocol.ServerMsg) { m.Scope = "container" },
		"subject": func(m *protocol.ServerMsg) { m.Subject += "2" },
		"path":    func(m *protocol.ServerMsg) { m.Path += "2" },
		"path2":   func(m *protocol.ServerMsg) { m.Path2 = "x" },
		"mode":    func(m *protocol.ServerMsg) { m.Mode = "0777" },
		"flags":   func(m *protocol.ServerMsg) { m.Flags = "" },
		"size":    func(m *protocol.ServerMsg) { m.Size++ },
		"sha":     func(m *protocol.ServerMsg) { m.Sha256 = strings.Repeat("0", 64) },
		"ifMatch": func(m *protocol.ServerMsg) { m.IfMatch = "1-1" },
		"xfer":    func(m *protocol.ServerMsg) { m.Xfer = strings.Replace(m.Xfer, "AAAA", "CCCC", 1) },
		"timeout": func(m *protocol.ServerMsg) { m.TimeoutMs++ },
		"exp":     func(m *protocol.ServerMsg) { m.Exp++ },
		"cap":     func(m *protocol.ServerMsg) { m.Capability = "files" },
	}
	for name, mut := range muts {
		h := newFs2Harness(t, allFiles, "img")
		m := base(h)
		mut(&m)
		h.g.handle(context.Background(), m)
		h.expectSilence()
		if h.launchN.Load() != 0 {
			t.Errorf("%s: tampered request reached the helper", name)
		}
	}
}

func TestFs2Expired(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	h.g.handle(context.Background(), h.msg("volume", "stat", func(m *protocol.ServerMsg) { m.Exp = h.nowT.Unix() - 1 }))
	r := h.expectReply()
	if r.OK || r.Code != "expired" {
		t.Fatalf("%+v", r)
	}
	if h.launchN.Load() != 0 {
		t.Fatal("expired request launched")
	}
	// exactly at exp is still valid
	h.g.handle(context.Background(), h.msg("volume", "stat", func(m *protocol.ServerMsg) { m.Exp = h.nowT.Unix() }))
	if r := h.expectReply(); !r.OK {
		t.Fatalf("at-exp request refused: %+v", r)
	}
}

func TestFs2ReplayRejected(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	m := h.msg("volume", "stat", nil)
	h.g.handle(context.Background(), m)
	if r := h.expectReply(); !r.OK {
		t.Fatalf("first: %+v", r)
	}
	h.g.handle(context.Background(), m)
	if r := h.expectReply(); r.OK || r.Code != "busy" {
		t.Fatalf("replay: %+v", r)
	}
	if h.launchN.Load() != 1 {
		t.Fatalf("launch count %d", h.launchN.Load())
	}
}

func TestFs2ReplayCacheBoundedAndPurged(t *testing.T) {
	s := newFs2State()
	for i := 0; i < fs2ReplayMax; i++ {
		if !s.remember(strings.Repeat("a", 3)+string(rune(i+0x4e00)), 2000, 1000) {
			t.Fatalf("remember %d refused", i)
		}
	}
	if s.remember("overflow", 2000, 1000) {
		t.Fatal("overflow with nothing purgeable must be refused")
	}
	// once the entries have expired the cache purges and accepts again
	if !s.remember("fresh", 4000, 3000) {
		t.Fatal("expired entries were not purged")
	}
}

func TestFs2CapabilitySetEnforcedIndividually(t *testing.T) {
	cases := []struct {
		scope, op string
		need      []string
	}{
		{"volume", "stat", []string{"files"}},
		{"volume", "read", []string{"files"}},
		{"volume", "write", []string{"files", "files_write"}},
		{"volume", "delete", []string{"files", "files_write"}},
		{"container", "list", []string{"files", "terminal"}},
		{"container", "read", []string{"files", "terminal"}},
		{"container", "write", []string{"files", "files_write", "terminal"}},
		{"container", "chmod", []string{"files", "files_write", "terminal"}},
	}
	for _, c := range cases {
		for _, missing := range c.need {
			var granted []string
			for _, a := range allFiles {
				if a != missing {
					granted = append(granted, a)
				}
			}
			h := newFs2Harness(t, granted, "img")
			h.g.container = func(context.Context, protocol.ServerMsg, *fs2Gate) protocol.Fs2Result {
				h.launchN.Add(1)
				return protocol.Fs2Result{OK: true}
			}
			h.g.handle(context.Background(), h.msg(c.scope, c.op, nil))
			h.expectSilence()
			if h.launchN.Load() != 0 {
				t.Errorf("%s %s without %s still ran", c.scope, c.op, missing)
			}
		}
		// with the full set it runs
		h := newFs2Harness(t, c.need, "img")
		h.g.container = func(context.Context, protocol.ServerMsg, *fs2Gate) protocol.Fs2Result {
			return protocol.Fs2Result{OK: true}
		}
		h.g.handle(context.Background(), h.msg(c.scope, c.op, nil))
		if r := h.expectReply(); !r.OK {
			t.Errorf("%s %s with exactly its set failed: %+v", c.scope, c.op, r)
		}
	}
}

func TestFs2FilesOnlyCannotMutate(t *testing.T) {
	h := newFs2Harness(t, []string{"files"}, "img")
	for _, op := range []string{"write", "mkdir", "rename", "chmod", "delete"} {
		h.g.handle(context.Background(), h.msg("volume", op, nil))
		h.expectSilence()
	}
	if h.launchN.Load() != 0 {
		t.Fatal("a mutating op ran with only files granted")
	}
}

func TestFs2SignedCapabilityMustMatchOp(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	// a validly signed mutating request that CLAIMS the weaker capability
	h.g.handle(context.Background(), h.msg("volume", "delete", func(m *protocol.ServerMsg) { m.Capability = "files" }))
	h.expectSilence()
	h.g.handle(context.Background(), h.msg("volume", "stat", func(m *protocol.ServerMsg) { m.Capability = "files_write" }))
	h.expectSilence()
	if h.launchN.Load() != 0 {
		t.Fatal("capability relabel reached the helper")
	}
}

func TestFs2UnknownScopeOrOp(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	h.g.handle(context.Background(), h.msg("volume", "list", nil))
	if r := h.expectReply(); r.Code != "bad_request" {
		t.Fatalf("%+v", r)
	}
	h.g.handle(context.Background(), h.msg("host", "read", nil))
	if r := h.expectReply(); r.Code != "bad_request" {
		t.Fatalf("%+v", r)
	}
}

func TestFs2NotConfiguredVolumeButContainerOK(t *testing.T) {
	h := newFs2Harness(t, allFiles, "")
	h.g.handle(context.Background(), h.msg("volume", "stat", nil))
	if r := h.expectReply(); r.OK || r.Code != "not_configured" {
		t.Fatalf("%+v", r)
	}
	h.g.container = func(context.Context, protocol.ServerMsg, *fs2Gate) protocol.Fs2Result {
		return protocol.Fs2Result{OK: true}
	}
	h.g.handle(context.Background(), h.msg("container", "stat", nil))
	if r := h.expectReply(); !r.OK {
		t.Fatalf("container scope must not need the agent image: %+v", r)
	}
}

func TestFs2ContainerUnavailableIsUnsupported(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	h.g.container = nil
	h.g.handle(context.Background(), h.msg("container", "stat", nil))
	if r := h.expectReply(); r.OK || r.Code != "unsupported" {
		t.Fatalf("%+v", r)
	}
}

func TestFs2FieldValidation(t *testing.T) {
	bad := map[string]func(*protocol.ServerMsg){
		"flags order":   func(m *protocol.ServerMsg) { m.Flags = "ro" },
		"flags dup":     func(m *protocol.ServerMsg) { m.Flags = "oo" },
		"flags junk":    func(m *protocol.ServerMsg) { m.Flags = "x" },
		"mode":          func(m *protocol.ServerMsg) { m.Mode = "4755" },
		"sha":           func(m *protocol.ServerMsg) { m.Sha256 = "zz" },
		"no sha":        func(m *protocol.ServerMsg) { m.Sha256 = "" },
		"ifMatch":       func(m *protocol.ServerMsg) { m.IfMatch = "x" },
		"xfer absolute": func(m *protocol.ServerMsg) { m.Xfer = "https://evil.example/x" },
		"xfer empty":    func(m *protocol.ServerMsg) { m.Xfer = "" },
		"size":          func(m *protocol.ServerMsg) { m.Size = -1 },
	}
	for name, mut := range bad {
		h := newFs2Harness(t, allFiles, "img")
		h.g.handle(context.Background(), h.msg("volume", "write", mut))
		r := h.expectReply()
		if r.OK || r.Code != "bad_request" {
			t.Errorf("%s: %+v", name, r)
		}
		if h.launchN.Load() != 0 {
			t.Errorf("%s: reached the helper", name)
		}
	}
	// a non-transfer op must not carry a transfer path
	h := newFs2Harness(t, allFiles, "img")
	h.g.handle(context.Background(), h.msg("volume", "stat", func(m *protocol.ServerMsg) { m.Xfer = tXfer }))
	if r := h.expectReply(); r.Code != "bad_request" {
		t.Fatalf("%+v", r)
	}
}

func TestFs2WriteFlow(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img:1")
	var gotReq fsd.Req2
	var gotBody string
	var gotOrigin, gotPath string
	h.g.get = func(ctx context.Context, origin, path string, size int64) (io.ReadCloser, error) {
		gotOrigin, gotPath = origin, path
		return io.NopCloser(strings.NewReader("hello")), nil
	}
	h.g.launch = func(ctx context.Context, image, volume string, r fsd.Req2, stdin io.Reader, stdout io.Writer) (fsd.Result2, error) {
		b, _ := io.ReadAll(stdin)
		gotBody, gotReq = string(b), r
		if image != "img:1" || volume != "tugra_appv_c1_data" {
			t.Errorf("image/volume = %s %s", image, volume)
		}
		return fsd.Result2{Bytes: 5, Sha256: tSha, Etag: "5-7", Created: true}, nil
	}
	h.g.handle(context.Background(), h.msg("volume", "write", nil))
	r := h.expectReply()
	if !r.OK || r.Bytes != 5 || r.Etag != "5-7" || !r.Created || r.Sha256 != tSha || r.Type != "fs2_result" {
		t.Fatalf("%+v", r)
	}
	if gotBody != "hello" || gotReq.Op != "write" || gotReq.Flags != "o" || gotReq.Mode != "0644" || gotReq.Size != 5 {
		t.Fatalf("req %+v body %q", gotReq, gotBody)
	}
	// the URL is built from the AGENT's own hub origin, never from the message
	if gotOrigin != "http://hub-api:3000" || gotPath != tXfer {
		t.Fatalf("origin=%q path=%q", gotOrigin, gotPath)
	}
}

func TestFs2WriteFetchFailure(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	h.g.get = func(context.Context, string, string, int64) (io.ReadCloser, error) {
		return nil, errors.New("dial tcp 10.0.0.9:3000: secret internal detail")
	}
	h.g.handle(context.Background(), h.msg("volume", "write", nil))
	r := h.expectReply()
	if r.OK || r.Code != "failed" || strings.Contains(r.Error, "10.0.0.9") {
		t.Fatalf("%+v", r)
	}
}

func TestFs2ReadFlow(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	payload := []byte("hello")
	h.g.launch = func(ctx context.Context, image, volume string, r fsd.Req2, stdin io.Reader, stdout io.Writer) (fsd.Result2, error) {
		if stdin != nil {
			t.Error("read must not carry stdin")
		}
		_, err := stdout.Write(payload)
		return fsd.Result2{}, err
	}
	var sunk bytes.Buffer
	h.g.putFrom = func(ctx context.Context, origin, path string, size int64, produce func(context.Context, io.Writer) error) error {
		if origin != "http://hub-api:3000" || path != tXfer || size != 5 {
			t.Errorf("putFrom args %q %q %d", origin, path, size)
		}
		return produce(ctx, &sunk)
	}
	h.g.handle(context.Background(), h.msg("volume", "read", nil))
	r := h.expectReply()
	sum := sha256.Sum256(payload)
	if !r.OK || r.Bytes != 5 || r.Sha256 != hex.EncodeToString(sum[:]) || sunk.String() != "hello" {
		t.Fatalf("%+v sunk=%q", r, sunk.String())
	}
}

func TestFs2ReadFailureSurfacesTypedError(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	h.g.putFrom = func(ctx context.Context, origin, path string, size int64, produce func(context.Context, io.Writer) error) error {
		return &fsd.Error{Code: fsd.CodeChanged, Msg: "file size changed"}
	}
	h.g.handle(context.Background(), h.msg("volume", "read", nil))
	if r := h.expectReply(); r.OK || r.Code != "changed" {
		t.Fatalf("%+v", r)
	}
}

func TestFs2ErrorMapping(t *testing.T) {
	cases := []struct {
		err  error
		code string
	}{
		{&fsd.Error{Code: "exists", Msg: "already exists"}, "exists"},
		{&fsd.Error{Code: "no_space", Msg: "x"}, "no_space"},
		{errors.New("docker boom /root/x"), "failed"},
		{context.DeadlineExceeded, "failed"},
	}
	for _, c := range cases {
		h := newFs2Harness(t, allFiles, "img")
		err := c.err
		h.g.launch = func(context.Context, string, string, fsd.Req2, io.Reader, io.Writer) (fsd.Result2, error) {
			return fsd.Result2{}, err
		}
		h.g.handle(context.Background(), h.msg("volume", "mkdir", nil))
		r := h.expectReply()
		if r.OK || r.Code != c.code {
			t.Errorf("%v -> %+v", c.err, r)
		}
		if strings.Contains(r.Error, "/root") {
			t.Errorf("host detail leaked: %q", r.Error)
		}
	}
}

func TestFs2ResultShapesPerOp(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	for _, op := range []string{"stat", "mkdir", "rename", "chmod"} {
		h.g.handle(context.Background(), h.msg("volume", op, nil))
		r := h.expectReply()
		if !r.OK || r.Stat == nil || r.Stat.Name != "x" {
			t.Errorf("%s: %+v", op, r)
		}
	}
	h.g.handle(context.Background(), h.msg("volume", "delete", nil))
	if r := h.expectReply(); !r.OK {
		t.Errorf("delete: %+v", r)
	}
}

func TestFs2SemaphoreBusy(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	h.g.semWait = 40 * time.Millisecond
	release := make(chan struct{})
	h.g.launch = func(ctx context.Context, _, _ string, _ fsd.Req2, _ io.Reader, _ io.Writer) (fsd.Result2, error) {
		<-release
		return fsd.Result2{}, nil
	}
	for i := 0; i < fs2MaxInFlight; i++ {
		h.g.handle(context.Background(), h.msg("volume", "stat", nil))
	}
	time.Sleep(60 * time.Millisecond)
	h.g.handle(context.Background(), h.msg("volume", "stat", nil))
	if r := h.expectReply(); r.OK || r.Code != "busy" {
		t.Fatalf("5th op: %+v", r)
	}
	close(release)
	for i := 0; i < fs2MaxInFlight; i++ {
		if r := h.expectReply(); !r.OK {
			t.Fatalf("%+v", r)
		}
	}
}

func TestFs2PerVolumeMutexSerializesWrites(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	var cur, peak atomic.Int32
	h.g.launch = func(ctx context.Context, _, _ string, _ fsd.Req2, _ io.Reader, _ io.Writer) (fsd.Result2, error) {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(40 * time.Millisecond)
		cur.Add(-1)
		return fsd.Result2{}, nil
	}
	for i := 0; i < 3; i++ {
		h.g.handle(context.Background(), h.msg("volume", "mkdir", nil))
	}
	for i := 0; i < 3; i++ {
		h.expectReply()
	}
	if peak.Load() != 1 {
		t.Fatalf("mutating ops on one volume overlapped (peak %d)", peak.Load())
	}
	// different volumes run in parallel; reads on one volume are not serialized
	peak.Store(0)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.g.handle(context.Background(), h.msg("volume", "stat", nil))
		}()
	}
	wg.Wait()
	for i := 0; i < 3; i++ {
		h.expectReply()
	}
	if peak.Load() < 2 {
		t.Fatalf("reads should overlap (peak %d)", peak.Load())
	}
}

func TestFs2VolumeLockWaitCountsAgainstDeadline(t *testing.T) {
	h := newFs2Harness(t, allFiles, "img")
	l := h.g.state.volLock("tugra_appv_c1_data")
	l <- struct{}{} // another writer holds the volume
	// the op deadline is clamped to >= 5s, so bound it with the parent context instead
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	h2 := newFs2Harness(t, allFiles, "img")
	h2.g.state = h.g.state
	h2.g.handle(ctx, h2.msg("volume", "mkdir", nil))
	if r := h2.expectReply(); r.OK || r.Code != "busy" {
		t.Fatalf("%+v", r)
	}
	<-l
}

func TestFs2TimeoutClamp(t *testing.T) {
	for ms, want := range map[int]time.Duration{
		0: 30 * time.Second, -5: 30 * time.Second, 1: 5 * time.Second, 4999: 5 * time.Second, 5000: 5 * time.Second,
		30000: 30 * time.Second, 599999: 599999 * time.Millisecond, 600000: 10 * time.Minute, 1 << 30: 10 * time.Minute,
	} {
		if got := fs2Timeout(ms); got != want {
			t.Errorf("fs2Timeout(%d) = %v want %v", ms, got, want)
		}
	}
}
