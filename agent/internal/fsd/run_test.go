package fsd

import (
	"context"
	"errors"
	"testing"
)

// withStubRunner swaps runHelper for the duration of a test and restores it after.
func withStubRunner(t *testing.T, fn func(ctx context.Context, args []string) ([]byte, string, error)) {
	t.Helper()
	orig := runHelper
	runHelper = fn
	t.Cleanup(func() { runHelper = orig })
}

// withStubReap swaps reapContainer (so unit tests never shell out to docker) and records invocations.
func withStubReap(t *testing.T) *bool {
	t.Helper()
	called := false
	orig := reapContainer
	reapContainer = func(string) { called = true }
	t.Cleanup(func() { reapContainer = orig })
	return &called
}

func TestLaunchParsesListing(t *testing.T) {
	withStubReap(t)
	var gotArgs []string
	withStubRunner(t, func(_ context.Context, args []string) ([]byte, string, error) {
		gotArgs = args
		return []byte(`{"entries":[{"name":"a","type":"file","size":3,"mode":"rw-r--r--","mtime":5}],"truncated":true}`), "", nil
	})
	entries, truncated, err := Launch(context.Background(), "ghcr.io/simeraycom/tugra-agent@sha256:abc", "tugra_appv_x_data", "list", "sub")
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	if !truncated {
		t.Error("truncated = false, want true")
	}
	if len(entries) != 1 || entries[0].Name != "a" || entries[0].Type != "file" {
		t.Errorf("entries = %+v, want one file 'a'", entries)
	}
	// The helper must have been invoked with the hardened named-volume mount (not a -v bind) and a --name.
	if !containsSeq(gotArgs, []string{"--mount", "type=volume,src=tugra_appv_x_data,dst=/data,readonly,volume-nocopy"}) {
		t.Errorf("args missing hardened --mount; got %v", gotArgs)
	}
	if !containsSeq(gotArgs, []string{"--name"}) {
		t.Errorf("args missing --name reap handle; got %v", gotArgs)
	}
}

func TestLaunchFailsClosedOnBadInputBeforeRunning(t *testing.T) {
	cases := []struct{ name, volume, op, path string }{
		{"host-path volume", "/etc", "list", "sub"},
		{"traversal path", "tugra_appv_x_data", "list", "../escape"},
		{"unknown op", "tugra_appv_x_data", "read", "sub"},
	}
	for _, c := range cases {
		withStubReap(t)
		ran := false
		withStubRunner(t, func(context.Context, []string) ([]byte, string, error) { ran = true; return nil, "", nil })
		if _, _, err := Launch(context.Background(), "img", c.volume, c.op, c.path); err == nil {
			t.Errorf("%s: Launch = nil error, want rejection", c.name)
		}
		if ran {
			t.Errorf("%s: helper ran despite invalid input — validation must gate BEFORE exec", c.name)
		}
	}
}

func TestLaunchSurfacesCleanHelperError(t *testing.T) {
	reaped := withStubReap(t)
	withStubRunner(t, func(context.Context, []string) ([]byte, string, error) {
		return nil, "fsd: not a directory", errors.New("exit status 1")
	})
	_, _, err := Launch(context.Background(), "img", "tugra_appv_x_data", "list", "f.txt")
	if err == nil || err.Error() != "not a directory" {
		t.Fatalf("err = %v, want the clean 'not a directory' helper message", err)
	}
	if !*reaped {
		t.Error("reapContainer not called on a failed run")
	}
}

func TestLaunchHidesDaemonNoiseBehindGenericError(t *testing.T) {
	withStubReap(t)
	withStubRunner(t, func(context.Context, []string) ([]byte, string, error) {
		// A docker/daemon failure (no "fsd:" prefix) must NOT reach the hub verbatim.
		return nil, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", errors.New("exit status 125")
	})
	_, _, err := Launch(context.Background(), "img", "tugra_appv_x_data", "list", "sub")
	if err != errOpFailed {
		t.Fatalf("err = %v, want errOpFailed (daemon detail must stay local)", err)
	}
}

func TestLaunchMapsTimeoutToFixedError(t *testing.T) {
	reaped := withStubReap(t)
	withStubRunner(t, func(ctx context.Context, _ []string) ([]byte, string, error) {
		// Simulate exec.CommandContext on an expired context: the CLI is killed and ctx.Err() is set.
		return nil, "signal: killed", errors.New("signal: killed")
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // ctx.Err() != nil
	_, _, err := Launch(ctx, "img", "tugra_appv_x_data", "list", "sub")
	if err != errOpTimedOut {
		t.Fatalf("err = %v, want errOpTimedOut (not the masking stderr)", err)
	}
	if !*reaped {
		t.Error("reapContainer not called on timeout — a daemon-owned container would orphan")
	}
}

func TestLaunchRejectsMalformedOutput(t *testing.T) {
	withStubReap(t)
	withStubRunner(t, func(context.Context, []string) ([]byte, string, error) {
		return []byte("not json"), "", nil
	})
	if _, _, err := Launch(context.Background(), "img", "tugra_appv_x_data", "list", "sub"); err != errOpFailed {
		t.Fatalf("err = %v, want errOpFailed on malformed helper output", err)
	}
}
