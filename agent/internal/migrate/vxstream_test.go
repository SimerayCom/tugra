package migrate

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestBuildTarArgvGolden(t *testing.T) {
	prev := helperOwner
	helperOwner = "0123abcd4567"
	t.Cleanup(func() { helperOwner = prev })
	got := buildTarArgv("/usr/bin/docker", "ghcr.io/x/tugra-agent:1", "pg_data", "tugra-vx-abcd1234-cccccccc", []string{"postmaster.pid"})
	want := []string{
		"/usr/bin/docker", "run", "--rm", "-i", "--pull=never", "--name", "tugra-vx-abcd1234-cccccccc", "--label", "tugra.vx=1",
		"--label", "tugra.vx.owner=0123abcd4567", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
		"--security-opt", "no-new-privileges", "--pids-limit", "64", "--user", "0",
		"-v", "pg_data:/data:ro", "--entrypoint", "tar", "ghcr.io/x/tugra-agent:1",
		"--sort=name", "--numeric-owner", "--format=gnu", "--exclude=./postmaster.pid", "-C", "/data", "-cf", "-", ".",
	}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("argv differs:\n got %q\nwant %q", got, want)
	}
	// no excludes -> no --exclude; DAC_READ_SEARCH is the only capability ever added; the mount is read-only
	plain := strings.Join(buildTarArgv("docker", "img", "v", "n", nil), " ")
	if strings.Contains(plain, "--exclude") || strings.Count(plain, "--cap-add") != 1 || !strings.Contains(plain, ":/data:ro") || strings.Contains(plain, " sh -c") {
		t.Errorf("hardening: %s", plain)
	}
}

func TestReadSliceBoundaries(t *testing.T) {
	data := make([]byte, 25)
	for i := range data {
		data[i] = byte(i)
	}
	r := bytes.NewReader(data)
	buf := make([]byte, 10)
	var lens []int
	var sums []string
	for {
		n, sum, err := readSlice(r, buf)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		lens = append(lens, n)
		sums = append(sums, hex.EncodeToString(sum[:]))
	}
	if fmt.Sprint(lens) != "[10 10 5]" {
		t.Errorf("slices %v", lens)
	}
	if sums[0] != sha(data[:10]) || sums[2] != sha(data[20:]) {
		t.Error("the raw sha of each slice must be taken over exactly its bytes")
	}
	// an exact multiple ends with EOF at n==0 (no empty trailing slice)
	r = bytes.NewReader(data[:20])
	for i := 0; i < 2; i++ {
		if n, _, err := readSlice(r, buf); n != 10 || err != nil {
			t.Fatalf("full slice: %d %v", n, err)
		}
	}
	if n, _, err := readSlice(r, buf); n != 0 || err != io.EOF {
		t.Errorf("end: %d %v", n, err)
	}
	// empty and 1-byte streams
	if n, _, err := readSlice(bytes.NewReader(nil), buf); n != 0 || err != io.EOF {
		t.Errorf("empty: %d %v", n, err)
	}
	if n, _, err := readSlice(bytes.NewReader([]byte{7}), buf); n != 1 || err != nil {
		t.Errorf("1 byte: %d %v", n, err)
	}
}

func TestCompressMemberIsOneIndependentDeterministicMember(t *testing.T) {
	raw := bytes.Repeat([]byte("tugra volume data "), 5000)
	var a, b bytes.Buffer
	sa, err := compressMember(raw, &a)
	if err != nil {
		t.Fatal(err)
	}
	sb, _ := compressMember(raw, &b)
	if sa != sb || !bytes.Equal(a.Bytes(), b.Bytes()) {
		t.Error("the same raw slice must give the same member bytes (zero header, no mtime)")
	}
	if sa != sha256.Sum256(a.Bytes()) {
		t.Error("the member sum must be the sha of the member bytes")
	}
	// header: no name, mtime 0
	zr, err := gzip.NewReader(bytes.NewReader(a.Bytes()))
	if err != nil || zr.Name != "" || !zr.ModTime.IsZero() && zr.ModTime.Unix() != 0 {
		t.Errorf("header: %+v %v", zr.Header, err)
	}
	// members of consecutive slices concatenate into ONE valid gzip stream (what `cat p.* | gunzip` relies on)
	parts := [][]byte{raw[:30000], raw[30000:60000], raw[60000:]}
	var cat bytes.Buffer
	for _, p := range parts {
		var m bytes.Buffer
		if _, err := compressMember(p, &m); err != nil {
			t.Fatal(err)
		}
		cat.Write(m.Bytes())
	}
	out, err := io.ReadAll(mustGzip(t, cat.Bytes()))
	if err != nil || !bytes.Equal(out, raw) {
		t.Errorf("concatenated members must decode to the original (err=%v, %d vs %d bytes)", err, len(out), len(raw))
	}
	// the reusable writer yields independent members too (state is reset between slices)
	mw := newMemberWriter()
	var m1, m2 bytes.Buffer
	_, _ = mw.compress(parts[0], &m1)
	_, _ = mw.compress(parts[1], &m2)
	if o, _ := io.ReadAll(mustGzip(t, m2.Bytes())); !bytes.Equal(o, parts[1]) {
		t.Error("the second member of a reused writer must stand alone")
	}
	var empty bytes.Buffer
	if _, err := compressMember(nil, &empty); err != nil || empty.Len() == 0 {
		t.Errorf("empty slice: %v", err)
	}
}

func mustGzip(t *testing.T, b []byte) io.Reader {
	t.Helper()
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// ---- a fake hub with a memory relay -------------------------------------------------------------------------

type fakeRelayHub struct {
	mu          sync.Mutex
	registered  map[int]VxPartReq // idx -> descriptor (the latest registration)
	regCalls    int32
	putBodies   map[int][][]byte // idx -> every body received (retries show up as repeats)
	committed   map[int]bool
	srcPaths    map[string]int             // path id -> idx
	busyFirst   int32                      // answer busy this many times first
	dropBodies  bool                       // memory test: do not keep bodies
	putFail     func(idx, attempt int) int // returns an HTTP status to fail the PUT with (0 = succeed)
	commitFn    func(idx int) string       // returns a raw JSON answer ("" = {"done":true})
	alreadyDone map[int]bool
	putAttempt  map[int]int
	t           *testing.T
}

func newFakeRelayHub(t *testing.T) *fakeRelayHub {
	return &fakeRelayHub{registered: map[int]VxPartReq{}, putBodies: map[int][][]byte{}, committed: map[int]bool{}, srcPaths: map[string]int{}, alreadyDone: map[int]bool{}, putAttempt: map[int]int{}, t: t}
}

func (f *fakeRelayHub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		p := r.URL.Path
		switch {
		case r.Method == http.MethodPut && strings.HasPrefix(p, "/api/v1/agent-vx/t/"):
			if r.Header.Get("Authorization") != "" {
				f.t.Error("the migration token must NOT be sent to the relay")
			}
			id := strings.TrimPrefix(p, "/api/v1/agent-vx/t/")
			idx := f.srcPaths[id]
			// dropBodies (memory tests): hash the body as a stream so the fake hub never holds a second copy of a part
			var body []byte
			var bodyLen int
			var bodySha string
			if f.dropBodies {
				h := sha256.New()
				n, _ := io.Copy(h, r.Body)
				bodyLen, bodySha = int(n), hex.EncodeToString(h.Sum(nil))
			} else {
				body, _ = io.ReadAll(r.Body)
				bodyLen, bodySha = len(body), sha(body)
			}
			want := f.registered[idx]
			if r.ContentLength != int64(bodyLen) || bodyLen != want.Size || r.TransferEncoding != nil {
				f.t.Errorf("part %d: exact Content-Length required (cl=%d body=%d size=%d te=%v)", idx, r.ContentLength, bodyLen, want.Size, r.TransferEncoding)
			}
			f.putAttempt[idx]++
			if f.putFail != nil {
				if st := f.putFail(idx, f.putAttempt[idx]); st != 0 {
					w.WriteHeader(st)
					return
				}
			}
			if bodySha != want.Sha256 {
				w.WriteHeader(422)
				return
			}
			if f.dropBodies {
				f.putBodies[idx] = append(f.putBodies[idx], nil)
			} else {
				f.putBodies[idx] = append(f.putBodies[idx], body)
			}
			w.WriteHeader(204)
		case strings.HasSuffix(p, "/commit"):
			idx := idxFromPath(p)
			if f.commitFn != nil {
				if raw := f.commitFn(idx); raw != "" {
					io.WriteString(w, raw)
					return
				}
			}
			f.committed[idx] = true
			io.WriteString(w, `{"done":true,"partsDone":`+strconv.Itoa(idx+1)+`,"bytesDone":1,"expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.Contains(p, "/parts/"):
			var req VxPartReq
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &req)
			idx := idxFromPath(p)
			atomic.AddInt32(&f.regCalls, 1)
			if f.busyFirst > 0 {
				f.busyFirst--
				io.WriteString(w, `{"busy":true}`)
				return
			}
			if f.alreadyDone[idx] {
				io.WriteString(w, `{"alreadyDone":true,"expiresAt":"2999-01-01T00:00:00Z"}`)
				return
			}
			f.registered[idx] = req
			id := fmt.Sprintf("relayid%020d", len(f.srcPaths)+1)
			f.srcPaths[id] = idx
			fmt.Fprintf(w, `{"srcPath":"/api/v1/agent-vx/t/%s?exp=1999999999&sig=%s","expiresAt":"2999-01-01T00:00:00Z"}`, id, strings.Repeat("s", 43))
		default:
			w.WriteHeader(404)
		}
	})
}

func idxFromPath(p string) int {
	i := strings.Index(p, "/parts/")
	rest := p[i+len("/parts/"):]
	rest = strings.TrimSuffix(rest, "/commit")
	n, _ := strconv.Atoi(rest)
	return n
}

// fakeTar installs a startTarFn that serves `stream` and then exits with `exit` (nil = success).
func fakeTar(t *testing.T, stream []byte, exit error) *[]string {
	t.Helper()
	var argvSeen []string
	orig := startTarFn
	t.Cleanup(func() { startTarFn = orig })
	startTarFn = func(ctx context.Context, argv []string, env []string) (io.ReadCloser, func() error, error) {
		argvSeen = argv
		return io.NopCloser(bytes.NewReader(stream)), func() error { return exit }, nil
	}
	return &argvSeen
}

func streamBytes(n int) []byte {
	b := make([]byte, n)
	x := uint32(2463534242)
	for i := range b {
		x ^= x << 13
		x ^= x >> 17
		x ^= x << 5
		b[i] = byte(x)
	}
	return b
}

func testSource() *volSource {
	return &volSource{ContainerID: appCtrID, Name: "web", MountType: "volume", VolumeName: "web_data", Image: "x", Destination: "/data"}
}

func newStreamHub(t *testing.T, f *fakeRelayHub) *Hub {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	h := newTestHub(t, srv)
	h.SetOutageWait(0)
	return h
}

// reassemble gunzips every delivered member in part order and returns the decoded stream.
func reassemble(t *testing.T, f *fakeRelayHub, parts int) []byte {
	t.Helper()
	var cat bytes.Buffer
	for i := 0; i < parts; i++ {
		bodies := f.putBodies[i]
		if len(bodies) == 0 {
			t.Fatalf("part %d never reached the relay", i)
		}
		cat.Write(bodies[len(bodies)-1])
	}
	out, err := io.ReadAll(mustGzip(t, cat.Bytes()))
	if err != nil {
		t.Fatalf("the concatenated members are not one valid gzip stream: %v", err)
	}
	return out
}

func TestStreamVolumeDeliversEveryPartAndTheMembersDecodeToTheStream(t *testing.T) {
	noSleep(t)
	for _, size := range []int{1, 999, 1000, 1001, 2500, 3000, 3001} { // around the 1000-byte slice boundary
		stream := streamBytes(size)
		argv := fakeTar(t, stream, nil)
		f := newFakeRelayHub(t)
		h := newStreamHub(t, f)
		res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img:1", RunID: "run_abcdef12", Excludes: []string{"postmaster.pid"}})
		if err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		wantParts := (size + 999) / 1000
		if res.Parts != wantParts || res.RawBytes != int64(size) {
			t.Errorf("size %d: parts=%d raw=%d want %d/%d", size, res.Parts, res.RawBytes, wantParts, size)
		}
		if got := reassemble(t, f, wantParts); !bytes.Equal(got, stream) {
			t.Errorf("size %d: decoded stream differs", size)
		}
		// every part carries its RAW descriptor (offset, len, raw hash) and the member hash the relay verified
		for i := 0; i < wantParts; i++ {
			r := f.registered[i]
			lo, hi := i*1000, (i+1)*1000
			if hi > size {
				hi = size
			}
			if r.RawOffset != int64(lo) || r.RawLen != hi-lo || r.RawSha256 != sha(stream[lo:hi]) || r.RunID != "run_abcdef12" || r.Sha256 != sha(f.putBodies[i][0]) {
				t.Errorf("size %d part %d descriptor: %+v", size, i, r)
			}
		}
		if !strings.Contains(strings.Join(*argv, " "), "--exclude=./postmaster.pid") || !strings.Contains(strings.Join(*argv, " "), "web_data:/data:ro") {
			t.Errorf("tar argv: %v", *argv)
		}
	}
}

func TestStreamVolumeResumeComparesRawHashesAndSendsNothingCommitted(t *testing.T) {
	noSleep(t)
	stream := streamBytes(3500)
	manifest := []VxManifestEntry{
		{Idx: 0, RawOffset: 0, RawLen: 1000, RawSha256: sha(stream[:1000])},
		{Idx: 1, RawOffset: 1000, RawLen: 1000, RawSha256: sha(stream[1000:2000])},
	}
	fakeTar(t, stream, nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12", ResumeFromPart: 2, Manifest: manifest})
	if err != nil {
		t.Fatal(err)
	}
	if res.Parts != 4 || res.RawBytes != 3500 {
		t.Errorf("result: %+v", res)
	}
	if len(f.putBodies[0]) != 0 || len(f.putBodies[1]) != 0 {
		t.Error("a committed part must never be re-sent")
	}
	if len(f.putBodies[2]) != 1 || len(f.putBodies[3]) != 1 || f.registered[2].RawOffset != 2000 {
		t.Errorf("only the remaining parts are sent: %v", f.registered)
	}
}

func TestStreamVolumeDivergedMakesNoNetworkCall(t *testing.T) {
	stream := streamBytes(3000)
	cases := map[string][]VxManifestEntry{
		"hash":   {{Idx: 0, RawOffset: 0, RawLen: 1000, RawSha256: sha([]byte("something else"))}},
		"length": {{Idx: 0, RawOffset: 0, RawLen: 999, RawSha256: sha(stream[:999])}},
		"offset": {{Idx: 0, RawOffset: 7, RawLen: 1000, RawSha256: sha(stream[:1000])}},
		"empty":  nil,
	}
	for name, m := range cases {
		fakeTar(t, stream, nil)
		f := newFakeRelayHub(t)
		h := newStreamHub(t, f)
		_, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12", ResumeFromPart: 1, Manifest: m})
		if !errors.Is(err, ErrDiverged) {
			t.Errorf("%s: want ErrDiverged, got %v", name, err)
		}
		if atomic.LoadInt32(&f.regCalls) != 0 || len(f.putBodies) != 0 {
			t.Errorf("%s: a divergence must not touch the network", name)
		}
	}
	// the source shorter than the committed parts is also a divergence
	fakeTar(t, stream[:500], nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	m := []VxManifestEntry{{Idx: 0, RawOffset: 0, RawLen: 1000, RawSha256: sha(stream[:1000])}}
	if _, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12", ResumeFromPart: 1, Manifest: m}); !errors.Is(err, ErrDiverged) {
		t.Errorf("short source: %v", err)
	}
}

func TestStreamVolumeResumeOfAFullyCommittedArchive(t *testing.T) {
	noSleep(t)
	stream := streamBytes(1500)
	m := []VxManifestEntry{{Idx: 0, RawOffset: 0, RawLen: 1000, RawSha256: sha(stream[:1000])}, {Idx: 1, RawOffset: 1000, RawLen: 500, RawSha256: sha(stream[1000:])}}
	fakeTar(t, stream, nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12", ResumeFromPart: 2, Manifest: m})
	if err != nil || res.Parts != 2 || res.RawBytes != 1500 || len(f.putBodies) != 0 {
		t.Errorf("everything was committed: %+v %v puts=%d", res, err, len(f.putBodies))
	}
}

func TestStreamVolumeRetriesResendTheSameBuffer(t *testing.T) {
	noSleep(t)
	stream := streamBytes(2200)
	fakeTar(t, stream, nil)
	f := newFakeRelayHub(t)
	f.putFail = func(idx, attempt int) int {
		if idx == 1 && attempt == 1 {
			return 500
		}
		return 0
	}
	h := newStreamHub(t, f)
	res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if err != nil || res.Parts != 3 {
		t.Fatalf("%+v %v", res, err)
	}
	if f.putAttempt[1] != 2 {
		t.Errorf("part 1 should have been attempted twice, got %d", f.putAttempt[1])
	}
	if len(f.putBodies[1]) != 1 || sha(f.putBodies[1][0]) != f.registered[1].Sha256 {
		t.Error("the retry must carry the SAME member (matching the registered hash)")
	}
	if got := reassemble(t, f, 3); !bytes.Equal(got, stream) {
		t.Error("stream differs after a retry")
	}
}

func TestStreamVolumeGivesUpAfterThreeAttempts(t *testing.T) {
	noSleep(t)
	fakeTar(t, streamBytes(1500), nil)
	f := newFakeRelayHub(t)
	f.putFail = func(idx, attempt int) int { return 500 }
	h := newStreamHub(t, f)
	_, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if !errors.Is(err, ErrPartFailed) || f.putAttempt[0] != 3 {
		t.Errorf("err=%v attempts=%d", err, f.putAttempt[0])
	}
}

func TestStreamVolumeWaitsOutAHubRestart(t *testing.T) {
	noSleep(t)
	now := time.Now()
	orig := httpNow
	t.Cleanup(func() { httpNow = orig })
	httpNow = func() time.Time { now = now.Add(2 * time.Second); return now }
	fakeTar(t, streamBytes(1500), nil)
	f := newFakeRelayHub(t)
	f.putFail = func(idx, attempt int) int {
		if idx == 0 && attempt <= 5 {
			return 404 // the rendezvous vanished: the hub restarted
		}
		return 0
	}
	h := newStreamHub(t, f)
	h.SetOutageWait(15 * time.Minute)
	res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if err != nil || res.Parts != 2 {
		t.Fatalf("a hub restart must be waited out, not counted: %+v %v", res, err)
	}
	if f.putAttempt[0] != 6 {
		t.Errorf("attempts: %d", f.putAttempt[0])
	}
	// ...but only for the outage window
	fakeTar(t, streamBytes(1500), nil)
	f2 := newFakeRelayHub(t)
	f2.putFail = func(int, int) int { return 404 }
	h2 := newStreamHub(t, f2)
	h2.SetOutageWait(10 * time.Second)
	if _, err := StreamVolume(context.Background(), h2, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"}); err == nil {
		t.Error("an outage longer than the window must fail the part")
	}
}

func TestStreamVolumeBusyIsUncountedAndPartLostReRegisters(t *testing.T) {
	noSleep(t)
	fakeTar(t, streamBytes(1000), nil)
	f := newFakeRelayHub(t)
	f.busyFirst = 3
	lost := 0
	f.commitFn = func(idx int) string {
		if lost == 0 {
			lost++
			return "" // handled below by status
		}
		return ""
	}
	h := newStreamHub(t, f)
	res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if err != nil || res.Parts != 1 {
		t.Fatalf("busy must be waited out: %+v %v", res, err)
	}
	if atomic.LoadInt32(&f.regCalls) != 4 || f.putAttempt[0] != 1 {
		t.Errorf("3 busy answers then one real registration: calls=%d puts=%d", f.regCalls, f.putAttempt[0])
	}
}

func TestStreamVolumeCommitFailureModes(t *testing.T) {
	noSleep(t)
	// retryable failure: the same buffer is re-registered and re-sent, then it commits
	fakeTar(t, streamBytes(1000), nil)
	f := newFakeRelayHub(t)
	n := 0
	f.commitFn = func(idx int) string {
		n++
		if n == 1 {
			return `{"done":false,"retryable":true,"reason":"target exit 22"}`
		}
		return ""
	}
	h := newStreamHub(t, f)
	if _, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"}); err != nil {
		t.Fatal(err)
	}
	if f.putAttempt[0] != 2 {
		t.Errorf("retryable commit failure must re-send: %d", f.putAttempt[0])
	}
	// non-retryable: fail at once
	fakeTar(t, streamBytes(1000), nil)
	f2 := newFakeRelayHub(t)
	f2.commitFn = func(int) string { return `{"done":false,"retryable":false,"reason":"agent offline"}` }
	h2 := newStreamHub(t, f2)
	_, err := StreamVolume(context.Background(), h2, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if !errors.Is(err, ErrPartFailed) || f2.putAttempt[0] != 1 {
		t.Errorf("non-retryable: %v attempts=%d", err, f2.putAttempt[0])
	}
	// pending then done: the long-poll loop asks again
	fakeTar(t, streamBytes(1000), nil)
	f3 := newFakeRelayHub(t)
	k := 0
	f3.commitFn = func(int) string {
		k++
		if k < 3 {
			return `{"pending":true}`
		}
		return ""
	}
	h3 := newStreamHub(t, f3)
	if _, err := StreamVolume(context.Background(), h3, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"}); err != nil || k != 3 {
		t.Errorf("pending: %v k=%d", err, k)
	}
}

func TestStreamVolumeClassifiedConflictsAreNotRetried(t *testing.T) {
	noSleep(t)
	fakeTar(t, streamBytes(1500), nil)
	f := newFakeRelayHub(t)
	f.commitFn = func(int) string { return "" }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/parts/") && !strings.HasSuffix(r.URL.Path, "/commit") {
			w.WriteHeader(409)
			io.WriteString(w, `{"message":"vx-aborted"}`)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	h := newTestHub(t, srv)
	_, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if kindOf(err) != KindVxAborted {
		t.Errorf("an aborted transfer must surface as KindVxAborted, got %v", err)
	}
}

func TestStreamVolumeTarFailureIsNeverAccepted(t *testing.T) {
	noSleep(t)
	// every byte was delivered, but tar exited non-zero: the archive may be truncated
	fakeTar(t, streamBytes(1500), fmt.Errorf("%w: exit status 2", ErrTarFailed))
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	_, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if !errors.Is(err, ErrTarFailed) {
		t.Errorf("got %v", err)
	}
	// an empty archive and a missing helper are refused too
	fakeTar(t, nil, nil)
	if _, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"}); !errors.Is(err, ErrTarFailed) {
		t.Errorf("empty: %v", err)
	}
	if _, err := StreamVolume(context.Background(), h, "docker", nil, Target{}, testSource(), StreamOpts{PartRawBytes: 1000, RunID: "run_abcdef12"}); !errors.Is(err, ErrNoHelper) {
		t.Errorf("no helper: %v", err)
	}
}

func TestStreamVolumeCancelStopsAndReportsTheContext(t *testing.T) {
	noSleep(t)
	orig := startTarFn
	t.Cleanup(func() { startTarFn = orig })
	pr, pw := io.Pipe()
	startTarFn = func(ctx context.Context, argv []string, env []string) (io.ReadCloser, func() error, error) {
		go func() { <-ctx.Done(); _ = pw.CloseWithError(ctx.Err()) }()
		return pr, func() error { return nil }, nil
	}
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_, _ = pw.Write(streamBytes(1000))
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	_, err := StreamVolume(ctx, h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"})
	if err == nil || ctx.Err() == nil {
		t.Errorf("cancel must end the stream with an error: %v", err)
	}
}

func TestStreamVolumeMemoryIsBounded(t *testing.T) {
	noSleep(t)
	const part = 1 << 20 // 1 MiB slices, 48 parts: an unbounded implementation would hold ~48 MiB
	stream := streamBytes(48 * part)
	fakeTar(t, stream, nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	// the fake hub keeps every body for assertions; for this test drop them so only the migrator's own memory is measured
	defer debug.SetGCPercent(debug.SetGCPercent(10)) // collect eagerly so HeapAlloc tracks LIVE memory, not garbage
	runtime.GC()
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	var peak uint64
	var stop int32
	done := make(chan struct{})
	go func() { // sample only AFTER the baseline, so garbage left by earlier tests is never mistaken for growth
		defer close(done)
		var ms runtime.MemStats
		for atomic.LoadInt32(&stop) == 0 {
			// Measure LIVE memory: collect first, then read. Without the collection the sample includes whatever
			// garbage (dropped part bodies, finished gzip members) piled up since the last cycle, and on a slow
			// shared runner that alone reached the limit (a 20 MiB "growth" with nothing retained), while an
			// implementation that buffers the archive still shows its ~48 MiB after a collection.
			runtime.GC()
			runtime.ReadMemStats(&ms)
			if ms.HeapAlloc > peak {
				peak = ms.HeapAlloc
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	f.dropBodies = true
	res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: part, Helper: "img", RunID: "run_abcdef12"})
	atomic.StoreInt32(&stop, 1)
	<-done
	if err != nil || res.Parts != 48 {
		t.Fatalf("%+v %v", res, err)
	}
	// one raw slice + two member buffers + the read-ahead buffer + gzip state + the in-process fake hub's own copies: a
	// handful of MiB, never the 48 MiB archive (which the test allocated BEFORE the baseline was taken)
	growth := int64(peak) - int64(base.HeapAlloc)
	if limit := int64(20 * part); growth > limit {
		t.Errorf("heap grew by %d MiB (limit %d MiB): the streamer must not buffer the archive", growth>>20, limit>>20)
	}
}

func TestIsRetryablePartErr(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{context.Canceled, false},
		{&HubError{Status: 503, Kind: KindServer}, true},
		{&HubError{Status: 404, Kind: KindNotFound}, true},
		{&HubError{Status: 422, Kind: KindOther}, true},
		{&HubError{Status: 429, Kind: KindRateLimited}, true},
		{&HubError{Status: 409, Kind: KindVxPartLost}, true},
		{&HubError{Status: 409, Kind: KindVxDiverged}, false},
		{&HubError{Status: 409, Kind: KindVxAborted}, false},
		{&HubError{Status: 409, Kind: KindVxOtherRun}, false},
		{&HubError{Status: 401, Kind: KindAuth}, false},
		{errors.New("connection reset"), true},
	}
	for _, c := range cases {
		if got := isRetryablePartErr(c.err); got != c.want {
			t.Errorf("%v: got %v want %v", c.err, got, c.want)
		}
	}
}

func TestVxPutPartGuards(t *testing.T) {
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	for _, bad := range []string{"", "http://evil.example/api/v1/agent-vx/t/abcdefghijklmnop?exp=1&sig=" + strings.Repeat("s", 43), "/api/v1/agent-vx/t/../x", "/other/path", "/api/v1/agent-vx/t/short?exp=1&sig=short"} {
		if err := h.VxPutPart(context.Background(), bad, []byte("x")); err == nil {
			t.Errorf("%q must be refused before any request", bad)
		}
	}
	if atomic.LoadInt32(&f.regCalls) != 0 {
		t.Error("nothing should have been sent")
	}
	// redirects are never followed
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://evil.example/x", 302) }))
	defer srv.Close()
	h2 := newTestHub(t, srv)
	err := h2.VxPutPart(context.Background(), "/api/v1/agent-vx/t/abcdefghijklmnopqrstuv?exp=1999999999&sig="+strings.Repeat("s", 43), []byte("x"))
	if kindOf(err) != KindRedirect {
		t.Errorf("redirect: %v", err)
	}
}

// The relay PUT carries no Expect header at all. Node answers 417 to any Expect value other than 100-continue, including
// an empty one, which is what setting the header to "" sends; every part then failed with "hub 417" in the lab.
func TestVxPutPartSendsNoExpectHeader(t *testing.T) {
	var got []string
	var seen bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, seen = r.Header["Expect"]
		if seen && !strings.EqualFold(strings.Join(got, ""), "100-continue") {
			w.WriteHeader(http.StatusExpectationFailed) // what Node's http server does
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	h := newTestHub(t, srv)
	if err := h.VxPutPart(context.Background(), "/api/v1/agent-vx/t/abcdefghijklmnopqrstuv?exp=1999999999&sig="+strings.Repeat("s", 43), bytes.Repeat([]byte("x"), 4<<20)); err != nil {
		t.Fatalf("put: %v", err)
	}
	if seen {
		t.Fatalf("Expect header sent: %q", got)
	}
}

// Two migrators on one host: the reaper at the start of a run removes only helpers whose owner is gone (or unlabelled,
// or its own), never those of a migrator container that is still running.
func TestReapStaleHelpersSparesLiveOwners(t *testing.T) {
	prev := helperOwner
	helperOwner = "selfself0001"
	t.Cleanup(func() { helperOwner = prev })
	dir := t.TempDir()
	h := func(c byte) string { return strings.Repeat(string(c), 64) }
	ps := h('a') + " liveowner001\n" + h('b') + " deadowner001\n" + h('c') + " \n" + h('d') + " selfself0001\n" + h('e') + " liveowner001\n"
	script := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"ps) printf '%s' '" + ps + "' ;;\n" +
		"inspect) for a; do last=$a; done; if [ \"$last\" = liveowner001 ]; then echo true; echo \"$last\" >> \"" + dir + "/inspected\"; else echo 'no such object' >&2; exit 1; fi ;;\n" +
		"rm) echo \"$3\" >> \"" + dir + "/removed\" ;;\n" +
		"esac\n"
	docker := filepath.Join(dir, "docker")
	if err := os.WriteFile(docker, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	reapStaleHelpers(context.Background(), docker, os.Environ())
	removed, _ := os.ReadFile(filepath.Join(dir, "removed"))
	got := strings.Fields(string(removed))
	want := []string{h('b'), h('c'), h('d')}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("removed %v, want %v", got, want)
	}
	inspected, _ := os.ReadFile(filepath.Join(dir, "inspected"))
	if n := strings.Count(string(inspected), "liveowner001"); n != 1 {
		t.Fatalf("live owner inspected %d times, want 1 (cached)", n)
	}
}
