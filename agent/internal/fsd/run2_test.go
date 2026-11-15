package fsd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func withStubRunner2(t *testing.T, fn func(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer) (string, error)) {
	t.Helper()
	orig := runHelper2
	runHelper2 = fn
	t.Cleanup(func() { runHelper2 = orig })
}

func TestLaunch2ParsesWriteResult(t *testing.T) {
	reaped := withStubReap(t)
	var gotArgs []string
	var gotStdin []byte
	withStubRunner2(t, func(_ context.Context, args []string, stdin io.Reader, stdout io.Writer) (string, error) {
		gotArgs = args
		gotStdin, _ = io.ReadAll(stdin)
		_, _ = stdout.Write([]byte(`{"bytes":5,"sha256":"` + sha64 + `","etag":"5-9","created":true}`))
		return "", nil
	})
	res, err := Launch2(context.Background(), "img:1", "vol", Req2{Op: "write", Path: "a", Size: 5, Sha256: sha64}, strings.NewReader("hello"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Bytes != 5 || res.Etag != "5-9" || !res.Created || res.Sha256 != sha64 {
		t.Fatalf("result %+v", res)
	}
	if string(gotStdin) != "hello" {
		t.Fatalf("stdin wiring: %q", gotStdin)
	}
	if indexOf(gotArgs, "-i") < 0 {
		t.Fatal("write must run with -i")
	}
	if *reaped {
		t.Fatal("a clean run must not reap")
	}
}

func TestLaunch2ReadStreamsToSinkAndPassesNoStdin(t *testing.T) {
	withStubReap(t)
	withStubRunner2(t, func(_ context.Context, args []string, stdin io.Reader, stdout io.Writer) (string, error) {
		if stdin != nil {
			t.Error("read must not wire stdin")
		}
		_, _ = stdout.Write([]byte("RAWBYTES"))
		return "", nil
	})
	var sink bytes.Buffer
	if _, err := Launch2(context.Background(), "img", "vol", Req2{Op: "read", Path: "a", Size: 8}, nil, &sink); err != nil {
		t.Fatal(err)
	}
	if sink.String() != "RAWBYTES" {
		t.Fatalf("sink %q", sink.String())
	}
	if _, err := Launch2(context.Background(), "img", "vol", Req2{Op: "read", Path: "a", Size: 8}, nil, nil); err == nil {
		t.Fatal("read without a sink must be refused")
	}
}

func TestLaunch2TypedErrorAndReap(t *testing.T) {
	reaped := withStubReap(t)
	withStubRunner2(t, func(context.Context, []string, io.Reader, io.Writer) (string, error) {
		return "noise\nfsd: [exists] already exists\n", errors.New("exit status 1")
	})
	_, err := Launch2(context.Background(), "img", "vol", Req2{Op: "mkdir", Path: "a"}, nil, nil)
	var te *Error
	if !errors.As(err, &te) || te.Code != CodeExists || te.Msg != "already exists" {
		t.Fatalf("err = %v", err)
	}
	if !*reaped {
		t.Fatal("a runner failure must reap the container")
	}
}

func TestLaunch2UntypedFailureDoesNotLeakDetail(t *testing.T) {
	withStubReap(t)
	withStubRunner2(t, func(context.Context, []string, io.Reader, io.Writer) (string, error) {
		return "Cannot connect to the Docker daemon at unix:///var/run/docker.sock /root/secret", errors.New("exit status 125")
	})
	_, err := Launch2(context.Background(), "img", "vol", Req2{Op: "delete", Path: "a"}, nil, nil)
	if !errors.Is(err, errOpFailed) {
		t.Fatalf("err = %v, want errOpFailed", err)
	}
	if strings.Contains(err.Error(), "docker.sock") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("detail leaked: %v", err)
	}
}

func TestLaunch2TimeoutReaps(t *testing.T) {
	reaped := withStubReap(t)
	withStubRunner2(t, func(ctx context.Context, _ []string, _ io.Reader, _ io.Writer) (string, error) {
		<-ctx.Done()
		return "fsd: [failed] would be misleading", ctx.Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := Launch2(ctx, "img", "vol", Req2{Op: "stat", Path: "a"}, nil, nil)
	if !errors.Is(err, errOpTimedOut) || !IsTimeout(err) {
		t.Fatalf("err = %v, want errOpTimedOut", err)
	}
	if !*reaped {
		t.Fatal("timeout must reap")
	}
}

func TestLaunch2JSONCapAndBadJSON(t *testing.T) {
	withStubReap(t)
	withStubRunner2(t, func(_ context.Context, _ []string, _ io.Reader, stdout io.Writer) (string, error) {
		_, _ = stdout.Write(bytes.Repeat([]byte("x"), maxHelperJSON+10))
		return "", nil
	})
	if _, err := Launch2(context.Background(), "img", "vol", Req2{Op: "stat", Path: "a"}, nil, nil); !errors.Is(err, errOpFailed) {
		t.Fatalf("oversize output: %v", err)
	}
	withStubRunner2(t, func(_ context.Context, _ []string, _ io.Reader, stdout io.Writer) (string, error) {
		_, _ = stdout.Write([]byte("not json"))
		return "", nil
	})
	if _, err := Launch2(context.Background(), "img", "vol", Req2{Op: "stat", Path: "a"}, nil, nil); !errors.Is(err, errOpFailed) {
		t.Fatalf("bad json: %v", err)
	}
}

func TestLaunch2ValidatesBeforeRunning(t *testing.T) {
	withStubRunner2(t, func(context.Context, []string, io.Reader, io.Writer) (string, error) {
		t.Fatal("runner must not be reached")
		return "", nil
	})
	_, err := Launch2(context.Background(), "img", "/etc", Req2{Op: "stat", Path: "a"}, nil, nil)
	var te *Error
	if !errors.As(err, &te) || te.Code != CodeBadRequest {
		t.Fatalf("err = %v", err)
	}
	if _, err := Launch2(context.Background(), "img", "vol", Req2{Op: "write", Path: "a"}, nil, nil); err == nil {
		t.Fatal("write without a body must be refused")
	}
}

func TestLimitedBuffer(t *testing.T) {
	lb := &limitedBuffer{max: 4}
	n, err := lb.Write([]byte("abcdef"))
	if n != 6 || err != nil || lb.buf.String() != "abcd" || !lb.overflow {
		t.Fatalf("n=%d err=%v buf=%q overflow=%v", n, err, lb.buf.String(), lb.overflow)
	}
	n, _ = lb.Write([]byte("zz"))
	if n != 2 || lb.buf.String() != "abcd" {
		t.Fatal("must keep discarding silently")
	}
}

func TestParseHelperErr(t *testing.T) {
	if _, ok := parseHelperErr("random"); ok {
		t.Fatal("untyped stderr matched")
	}
	te, ok := parseHelperErr("x\nfsd: [no_space] no space left on volume")
	if !ok || te.Code != "no_space" {
		t.Fatalf("%v %v", te, ok)
	}
}

// --- the helper CLI end to end against a temp root (no docker) ---

func cli(t *testing.T, root string, stdin string, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := runCLI2(root, args, strings.NewReader(stdin), &out, &errb)
	return code, out.String(), errb.String()
}

func TestRunCLI2RoundTrip(t *testing.T) {
	root := t.TempDir()
	sum := shaHex([]byte("hello"))
	code, out, errs := cli(t, root, "hello", "write", "--path=d.txt", "--size=5", "--sha256="+sum, "--mode=0640")
	if code != 0 || !strings.Contains(out, `"created":true`) || !strings.Contains(out, sum) {
		t.Fatalf("write: %d %q %q", code, out, errs)
	}
	code, out, _ = cli(t, root, "", "stat", "--path=d.txt")
	if code != 0 || !strings.Contains(out, `"mode":"0640"`) || !strings.Contains(out, `"type":"file"`) {
		t.Fatalf("stat: %d %q", code, out)
	}
	code, out, _ = cli(t, root, "", "read", "--path=d.txt", "--size=5")
	if code != 0 || out != "hello" {
		t.Fatalf("read: %d %q", code, out)
	}
	code, _, errs = cli(t, root, "", "write", "--path=d.txt", "--size=1")
	if code != 1 || !strings.Contains(errs, "fsd: [exists]") {
		t.Fatalf("dup write: %d %q", code, errs)
	}
	if code, _, _ = cli(t, root, "", "mkdir", "--path=a/b", "--flags=p"); code != 0 {
		t.Fatalf("mkdir -p: %d", code)
	}
	if code, _, _ = cli(t, root, "", "rename", "--path=d.txt", "--path2=a/b/e.txt"); code != 0 {
		t.Fatalf("rename: %d", code)
	}
	if code, out, _ = cli(t, root, "", "chmod", "--path=a/b/e.txt", "--mode=600"); code != 0 || !strings.Contains(out, `"mode":"0600"`) {
		t.Fatalf("chmod: %d %q", code, out)
	}
	if code, _, errs = cli(t, root, "", "delete", "--path=a"); code != 1 || !strings.Contains(errs, "[not_empty]") {
		t.Fatalf("non-recursive delete: %d %q", code, errs)
	}
	if code, _, _ = cli(t, root, "", "delete", "--path=a", "--flags=r"); code != 0 {
		t.Fatalf("recursive delete: %d", code)
	}
	if _, err := os.Lstat(filepath.Join(root, "a")); err == nil {
		t.Fatal("a survived")
	}
}

func TestRunCLI2UsageErrors(t *testing.T) {
	root := t.TempDir()
	for _, args := range [][]string{
		{}, {"bogus"}, {"stat", "path"}, {"stat", "--nope=1"}, {"write", "--path=a", "--size=x"},
		{"stat", "--flags=z"}, {"read", "--path=a"}, {"chmod", "--path=a"},
	} {
		if code, _, _ := cli(t, root, "", args...); code == 0 {
			t.Errorf("args %v exited 0", args)
		}
	}
	// a leading dash in a value stays a value
	if code, _, errs := cli(t, root, "", "stat", "--path=-rf"); code != 1 || !strings.Contains(errs, "[not_found]") {
		t.Fatalf("dash path: %d %q", code, errs)
	}
}

// stalledReader never yields until released, modelling a hub upload body that never arrives.
type stalledReader struct{ release chan struct{} }

func (s *stalledReader) Read(p []byte) (int, error) {
	<-s.release
	return 0, io.EOF
}

// The real runHelper2 must return within ctx timeout + WaitDelay even when the stdin producer never yields
// (os/exec alone blocks forever on its stdin copier goroutine in that case).
func TestRunHelper2ReturnsWhenStdinProducerStalls(t *testing.T) {
	sr := &stalledReader{release: make(chan struct{})}
	t.Cleanup(func() { close(sr.release) })
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := runHelper2(ctx, []string{"cat"}, sr, io.Discard)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error from the killed helper")
		}
	case <-time.After(10 * time.Second): // 300ms ctx + 5s WaitDelay + slack
		t.Fatal("runHelper2 hung on a stalled stdin producer")
	}
}

func TestRunHelper2DeliversStdinAndEOF(t *testing.T) {
	var out bytes.Buffer
	if _, err := runHelper2(context.Background(), []string{"cat"}, strings.NewReader("hello"), &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "hello" {
		t.Fatalf("got %q", out.String())
	}
}
