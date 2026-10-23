package migrate

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeStub writes an executable shell script acting as a fake `docker` binary. The dump command
// is built by recipe.go; the stub ignores the args and just produces the given stdout behavior.
func writeStub(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func pgPlan() Plan {
	return Plan{
		Argv:   []string{"docker", "exec", "-e", "PGPASSWORD", "ctr", "pg_dump"},
		Env:    []string{"PATH=/usr/bin:/bin"},
		Engine: "POSTGRES",
	}
}

func TestDumpHappyPath(t *testing.T) {
	stub := writeStub(t, `printf 'PGDMP-hello-world'`)
	res, err := dumpOne(context.Background(), stub, pgPlan(), t.TempDir(), 1<<20, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if res.RawBytes != int64(len("PGDMP-hello-world")) {
		t.Errorf("RawBytes=%d", res.RawBytes)
	}
	if res.GzBytes <= 0 || res.SHA256 == "" {
		t.Errorf("gz/sha missing: %+v", res)
	}
	// the spool really decompresses to the original
	f, _ := os.Open(res.Path)
	defer f.Close()
	gz, _ := gzip.NewReader(f)
	got, _ := io.ReadAll(gz)
	if string(got) != "PGDMP-hello-world" {
		t.Errorf("decompressed = %q", got)
	}
	_ = os.RemoveAll(dirOf(res.Path))
}

func TestDumpEmptyIsFailure(t *testing.T) {
	stub := writeStub(t, `exit 0`)
	if _, err := dumpOne(context.Background(), stub, pgPlan(), t.TempDir(), 1<<20, 10*time.Second); !errors.Is(err, errEmptyDump) {
		t.Fatalf("expected errEmptyDump, got %v", err)
	}
}

func TestDumpNonZeroExit(t *testing.T) {
	stub := writeStub(t, `printf X; exit 7`)
	if _, err := dumpOne(context.Background(), stub, pgPlan(), t.TempDir(), 1<<20, 10*time.Second); !errors.Is(err, errDumpExit) {
		t.Fatalf("expected errDumpExit, got %v", err)
	}
}

func TestDumpBadFormat(t *testing.T) {
	stub := writeStub(t, `printf 'this is not a pg archive'`)
	if _, err := dumpOne(context.Background(), stub, pgPlan(), t.TempDir(), 1<<20, 10*time.Second); !errors.Is(err, errBadFormat) {
		t.Fatalf("expected errBadFormat, got %v", err)
	}
}

func TestDumpMaxGzAbort(t *testing.T) {
	// incompressible data larger than the compressed cap -> abort + spool removed.
	stub := writeStub(t, `head -c 400000 /dev/urandom`)
	spool := t.TempDir()
	if _, err := dumpOne(context.Background(), stub, pgPlan(), spool, 50000, 10*time.Second); !errors.Is(err, errDumpTooBig) {
		t.Fatalf("expected errDumpTooBig, got %v", err)
	}
	entries, _ := os.ReadDir(spool)
	if len(entries) != 0 {
		t.Errorf("spool must be cleaned up after an abort, found %d entries", len(entries))
	}
}

func TestDumpTimeout(t *testing.T) {
	stub := writeStub(t, `sleep 5; printf PGDMP`)
	start := time.Now()
	_, err := dumpOne(context.Background(), stub, pgPlan(), t.TempDir(), 1<<20, 300*time.Millisecond)
	if !errors.Is(err, errDumpTimeout) {
		t.Fatalf("expected errDumpTimeout, got %v", err)
	}
	if time.Since(start) > 4*time.Second {
		t.Error("timeout did not kill the process group promptly")
	}
}

func TestDumpRejectsEmptyEnv(t *testing.T) {
	p := pgPlan()
	p.Env = nil
	if _, err := dumpOne(context.Background(), "/bin/true", p, t.TempDir(), 1<<20, time.Second); err == nil {
		t.Fatal("a nil child env must be refused (it would inherit os.Environ)")
	}
}
