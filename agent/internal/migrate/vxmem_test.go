package migrate

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The member buffer is allocated ONCE at the incompressible worst case (memberBound). Without the pre-size a bytes.Buffer
// fills by repeated append-growth: a 128 MiB member measured ~1.1x (a ~144 MiB capacity), an 8 MiB one 9 MiB, with the old
// and the new backing arrays alive together during every growth step. So the strict check is not "never doubles" (it never
// did) but "one allocation": the capacity after the FIRST compress into an empty buffer is the bound plus page-size rounding.
func TestCompressPreSizesTheMemberBuffer(t *testing.T) {
	raw := streamBytes(8 << 20) // incompressible
	var out bytes.Buffer
	mw := newMemberWriter()
	if _, err := mw.compress(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Len() < len(raw) {
		t.Fatalf("test data must be incompressible: member %d < raw %d", out.Len(), len(raw))
	}
	if out.Len() > memberBound(len(raw)) {
		t.Errorf("memberBound %d is below the real member size %d", memberBound(len(raw)), out.Len())
	}
	first := out.Cap()
	if first < memberBound(len(raw)) {
		t.Errorf("member capacity %d is below the bound %d: the buffer was not pre-sized", first, memberBound(len(raw)))
	}
	// 64 KiB of allocator rounding, nothing more: without the Grow call the capacity is ~1.1x the member (9 MiB for 8 MiB)
	if first > memberBound(len(raw))+(64<<10) {
		t.Errorf("member capacity %d is more than allocator rounding above the bound %d: the buffer grew by append instead of one pre-sized allocation", first, memberBound(len(raw)))
	}
	// reuse: a second slice of the same size must not reallocate
	ptr := &out.Bytes()[0]
	if _, err := mw.compress(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Cap() != first {
		t.Errorf("capacity changed on reuse: %d -> %d", first, out.Cap())
	}
	if &out.Bytes()[0] != ptr {
		t.Error("the member buffer was reallocated on reuse")
	}
	// and the member is still one valid, deterministic gzip stream
	zr, err := gzip.NewReader(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	back, err := io.ReadAll(zr)
	if err != nil || !bytes.Equal(back, raw) {
		t.Errorf("round trip: %v", err)
	}
}

// The same single-allocation property at the size that matters, with a buffer that starts at the size of an EARLIER, smaller
// slice (the last slice of a volume is short, a resumed run starts with whatever was left): growing to the bound must be one
// step, never a ladder of appends.
func TestCompressGrowsALargerSliceInOneStep(t *testing.T) {
	var out bytes.Buffer
	mw := newMemberWriter()
	small := streamBytes(1 << 20)
	if _, err := mw.compress(small, &out); err != nil {
		t.Fatal(err)
	}
	big := streamBytes(16 << 20)
	if _, err := mw.compress(big, &out); err != nil {
		t.Fatal(err)
	}
	if out.Cap() > memberBound(len(big))+(64<<10) {
		t.Errorf("capacity %d after a 16 MiB slice is above the one-step bound %d", out.Cap(), memberBound(len(big)))
	}
}

func TestMemberBoundCoversTinyAndEmpty(t *testing.T) {
	for _, n := range []int{0, 1, 100, 65535, 1 << 20} {
		raw := streamBytes(n)
		var out bytes.Buffer
		if _, err := compressMember(raw, &out); err != nil {
			t.Fatal(err)
		}
		if out.Len() > memberBound(n) {
			t.Errorf("n=%d: member %d exceeds bound %d", n, out.Len(), memberBound(n))
		}
	}
}

func TestApplyMemoryLimit(t *testing.T) {
	var got int64 = -1
	set := func(n int64) int64 { got = n; return 0 }
	if !applyMemoryLimit(func(string) (string, bool) { return "", false }, set) || got != migratorMemLimit {
		t.Errorf("unset GOMEMLIMIT must install %d, got %d", int64(migratorMemLimit), got)
	}
	got = -1
	if applyMemoryLimit(func(string) (string, bool) { return "256MiB", true }, set) || got != -1 {
		t.Error("an operator's GOMEMLIMIT must win")
	}
	got = -1
	if !applyMemoryLimit(func(string) (string, bool) { return "  ", true }, set) || got != migratorMemLimit {
		t.Error("a blank GOMEMLIMIT is unset")
	}
	// the limit sits below the migrator container's cap (--memory=768m) with room for the runtime's own overhead
	if migratorMemLimit >= 768<<20 || migratorMemLimit < 512<<20 {
		t.Errorf("limit %d MiB must sit between 512 and 768 MiB", migratorMemLimit>>20)
	}
}

func TestStreamVolumeInstallsTheMemoryLimit(t *testing.T) {
	noSleep(t)
	fakeTar(t, streamBytes(3000), nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	prev := debug.SetMemoryLimit(-1)
	defer debug.SetMemoryLimit(prev)
	memLimitOnce = sync.Once{} // a fresh process
	if _, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: 1000, Helper: "img", RunID: "run_abcdef12"}); err != nil {
		t.Fatal(err)
	}
	if v := os.Getenv("GOMEMLIMIT"); v != "" {
		t.Skip("GOMEMLIMIT is exported in this environment")
	}
	if cur := debug.SetMemoryLimit(-1); cur != migratorMemLimit {
		t.Errorf("StreamVolume must install the %d byte limit, runtime has %d", int64(migratorMemLimit), cur)
	}
}

// An end-to-end guard on the live heap for incompressible slices (every member as large as its slice): one raw slice and two
// members, ~3 slices. It is deliberately NOT the strict test of the pre-sizing: measured, the heap peaks at ~50 MiB with it and
// ~54 MiB without it for 16 MiB slices, a gap smaller than GC timing noise, so the limit leaves 8 MiB of headroom (56 MiB) and
// catches gross regressions (a second copy of a slice, buffers that are not reused: +16 MiB each). The strict checks are
// TestCompressPreSizesTheMemberBuffer and TestCompressGrowsALargerSliceInOneStep; L7 is the proof at the real 128 MiB size.
func TestStreamVolumeMemoryBoundedForIncompressibleSlices(t *testing.T) {
	noSleep(t)
	const part = 16 << 20
	const parts = 6
	fakeTar(t, streamBytes(parts*part), nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	f.dropBodies = true
	defer debug.SetGCPercent(debug.SetGCPercent(10))
	runtime.GC()
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	var peak uint64
	var stop int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		var ms runtime.MemStats
		for atomic.LoadInt32(&stop) == 0 {
			runtime.GC()
			runtime.ReadMemStats(&ms)
			if ms.HeapAlloc > peak {
				peak = ms.HeapAlloc
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	res, err := StreamVolume(context.Background(), h, "docker", nil, Target{ItemRef: "volume:s:a:data"}, testSource(), StreamOpts{PartRawBytes: part, Helper: "img", RunID: "run_abcdef12"})
	atomic.StoreInt32(&stop, 1)
	<-done
	if err != nil || res.Parts != parts {
		t.Fatalf("%+v %v", res, err)
	}
	growth := int64(peak) - int64(base.HeapAlloc)
	if limit := int64(3*part + 8<<20); growth > limit {
		t.Errorf("heap grew by %d MiB (limit %d MiB): a slice copy or an unreused member buffer is the likely cause", growth>>20, limit>>20)
	}
	t.Logf("peak growth %d MiB for %d MiB slices", growth>>20, part>>20)
}
