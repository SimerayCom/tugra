package migrate

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The 409 literal vectors are shared with the hub (apps/hub-api/test/fixtures/vx-409-literals.json is a byte-identical
// copy, enforced by a hub test): one JSON, two languages, so a renamed literal fails on BOTH sides.
func TestClassify409SharedVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/vx-409-literals.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Vectors []struct{ Message, Kind string } `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || len(v.Vectors) < 10 {
		t.Fatalf("vectors: %v (%d)", err, len(v.Vectors))
	}
	for _, c := range v.Vectors {
		if got := classify(409, c.Message).Kind.String(); got != c.Kind {
			t.Errorf("409 %q -> %s, want %s", c.Message, got, c.Kind)
		}
		// a hub that wraps the literal in a longer sentence (or upper-cases it) still classifies
		if got := classify(409, "Conflict: "+strings.ToUpper(c.Message)).Kind.String(); got != c.Kind {
			t.Errorf("wrapped %q -> %s, want %s", c.Message, got, c.Kind)
		}
	}
	if k := classify(409, "something else entirely").Kind; k != KindUnknownConflict {
		t.Errorf("an unknown 409 must stay UnknownConflict (fail closed), got %v", k)
	}
}

func TestKindNamesAreUnique(t *testing.T) {
	seen := map[string]ErrKind{}
	for k, n := range kindNames {
		if prev, dup := seen[n]; dup {
			t.Errorf("name %q used by %v and %v", n, prev, k)
		}
		seen[n] = k
	}
	if ErrKind(9999).String() != "Other" {
		t.Error("unknown kinds are Other")
	}
}

func vxTestHub(t *testing.T, h http.HandlerFunc) (*Hub, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return newTestHub(t, srv), srv
}

func TestVxInventoryAndDiskCheckWire(t *testing.T) {
	var gotInv invReq
	var gotDisk diskReq
	var diskPath string
	hub, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if r.Header.Get("Content-Type") != "application/json" || r.Method != http.MethodPost {
			t.Errorf("method/content-type: %s %s", r.Method, r.Header.Get("Content-Type"))
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/vx/inventory"):
			_ = json.Unmarshal(b, &gotInv)
			io.WriteString(w, `{"stored":1,"expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.HasSuffix(r.URL.Path, "/disk-check"):
			diskPath = r.URL.EscapedPath()
			_ = json.Unmarshal(b, &gotDisk)
			io.WriteString(w, `{"ok":true,"unknown":false,"details":{"totalBytes":5}}`)
		default:
			w.WriteHeader(404)
		}
	})
	code := 0
	exp, err := hub.VxInventory(context.Background(), "run_abc12345", []InvItem{{ItemRef: "volume:s:a:data", Found: true, MountType: "volume", RawBytes: 5, Entries: 2, ExitCode: &code, Image: "postgres:16"}})
	if err != nil || exp.Year() != 2999 {
		t.Fatalf("inventory: %v %v", exp, err)
	}
	if gotInv.RunID != "run_abc12345" || len(gotInv.Items) != 1 || gotInv.Items[0].ItemRef != "volume:s:a:data" || gotInv.Items[0].Image != "postgres:16" {
		t.Errorf("inventory body: %+v", gotInv)
	}
	n := int64(5)
	d, err := hub.VxDiskCheck(context.Background(), "volume:s:a:data", "run_abc12345", &n)
	if err != nil || !d.OK || d.Unknown {
		t.Fatalf("disk-check: %+v %v", d, err)
	}
	if !strings.Contains(diskPath, "/vx/volume:s:a:data/disk-check") || gotDisk.RawBytes == nil || *gotDisk.RawBytes != 5 {
		t.Errorf("disk-check wire: %s %+v", diskPath, gotDisk)
	}
}

func TestDoBodyRetriesTransientThenClassifies(t *testing.T) {
	noSleep(t)
	var n int32
	hub, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) {
		switch atomic.AddInt32(&n, 1) {
		case 1:
			w.WriteHeader(503)
		case 2:
			w.WriteHeader(502)
		default:
			io.WriteString(w, `{"stored":1,"expiresAt":"2999-01-01T00:00:00Z"}`)
		}
	})
	if _, err := hub.VxInventory(context.Background(), "run_abc12345", []InvItem{{ItemRef: "volume:s:a:data"}}); err != nil {
		t.Fatalf("a transient 503/502 must be retried: %v", err)
	}
	// a 409 literal is NOT retried and carries its kind
	var calls int32
	hub2, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(409)
		io.WriteString(w, `{"message":"vx-diverged"}`)
	})
	_, err := hub2.VxDiskCheck(context.Background(), "volume:s:a:data", "run_abc12345", nil)
	if kindOf(err) != KindVxDiverged || atomic.LoadInt32(&calls) != 1 {
		t.Errorf("409 vx-diverged: kind=%v calls=%d err=%v", kindOf(err), calls, err)
	}
	// a 404 is a real answer for control-plane calls (never waited out)
	hub3, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) })
	if _, err := hub3.VxInventory(context.Background(), "run_abc12345", []InvItem{{ItemRef: "volume:s:a:data"}}); kindOf(err) != KindNotFound {
		t.Errorf("404: %v", err)
	}
}

func TestDoBodyOutageWindowRetriesThenGivesUp(t *testing.T) {
	noSleep(t)
	now := time.Now()
	orig := httpNow
	t.Cleanup(func() { httpNow = orig })
	httpNow = func() time.Time { return now }
	var calls int32
	hub, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) >= 6 {
			io.WriteString(w, `{"stored":1,"expiresAt":"2999-01-01T00:00:00Z"}`)
			return
		}
		w.WriteHeader(503)
	})
	var out invResp
	if err := hub.doBody(context.Background(), http.MethodPost, "vx/inventory", invReq{RunID: "run_abc12345"}, &out, 1, time.Minute); err != nil || atomic.LoadInt32(&calls) != 6 {
		t.Fatalf("outage window should wait for the hub: calls=%d err=%v", calls, err)
	}
	// once the window has elapsed it gives up with the last classified error
	httpNow = func() time.Time { now = now.Add(20 * time.Second); return now } // time passes with every call
	atomic.StoreInt32(&calls, 0)
	hub2, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) })
	if err := hub2.doBody(context.Background(), http.MethodPost, "vx/inventory", invReq{}, &out, 1, time.Minute); err == nil {
		t.Error("an expired outage window must surface the error")
	}
}

func TestHubRefusesRedirectsAndForeignOriginOnVxCalls(t *testing.T) {
	hub, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example/steal", http.StatusFound)
	})
	_, err := hub.VxInventory(context.Background(), "run_abc12345", []InvItem{{ItemRef: "volume:s:a:data"}})
	if kindOf(err) != KindRedirect {
		t.Errorf("redirect must be refused: %v", err)
	}
	if _, rerr := hub.newReq(context.Background(), "POST", "https://evil.example/x", nil); rerr == nil {
		t.Error("a request to another origin must be refused")
	}
}

func TestTargetsRespCarriesVxFields(t *testing.T) {
	hub, _ := vxTestHub(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"opId":"op1","targets":[{"itemRef":"volume:s:a:data","kind":"volume","volumeIngest":"stream-v2","dest":{"type":"app-volume","name":"data","mountPath":"/x"},"appItemRef":"app:s:a","unknownFutureField":1}],"maxArtifactBytes":1,"maxVolumeBytes":2,"vxProtocol":1,"vx":{"partRawBytes":134217728,"maxBytes":100,"maxParts":5}}`)
	})
	tr, err := hub.Targets(context.Background())
	if err != nil || tr.VxProtocol != 1 || tr.Vx == nil || tr.Vx.PartRawBytes != 134217728 || tr.MaxVolumeBytes != 2 {
		t.Fatalf("%+v %v", tr, err)
	}
	if tg := tr.Targets[0]; tg.Kind != "volume" || tg.Dest == nil || tg.Dest.MountPath != "/x" || tg.AppItemRef != "app:s:a" {
		t.Errorf("volume row: %+v", tg)
	}
}
