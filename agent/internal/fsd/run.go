package fsd

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// errOpTimedOut is the stable error surfaced to the hub when a file op exceeds its wall-clock budget.
// It is fixed on purpose: a timeout must never be reported as "signal: killed" or masked by stray stderr.
var errOpTimedOut = errors.New("file operation timed out")

// errOpFailed is the generic error for a launcher/daemon failure that is NOT a clean helper message.
// The real detail stays in the agent's local log, never on the wire.
var errOpFailed = errors.New("file operation failed")

// runHelper executes the helper argv and returns its stdout plus trimmed stderr. It is a package var so
// tests can stub the docker invocation without a real daemon.
var runHelper = func(ctx context.Context, args []string) (stdout []byte, stderr string, err error) {
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err = cmd.Run()
	return out.Bytes(), strings.TrimSpace(errb.String()), err
}

// reapContainer force-removes a possibly-orphaned helper container. exec.CommandContext only kills the
// `docker run` CLI on a timeout — the daemon-owned container keeps running — so we remove it by name with
// a FRESH short context (never the expired one). Best-effort: a failure here is only logged. Package var
// for tests.
var reapContainer = func(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "rm", "-f", name)
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "fsd: reap %s: %v\n", name, err)
	}
}

type helperError struct{ msg string }

func (e *helperError) Error() string { return e.msg }

// helperOutput is the JSON the `fsd list` subcommand prints on stdout.
type helperOutput struct {
	Entries   []protocol.FsEntry `json:"entries"`
	Truncated bool               `json:"truncated"`
}

// newContainerName returns a unique, charset-safe --name handle for one helper run.
func newContainerName() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "tugra-fsd-" + hex.EncodeToString(b[:])
}

// Launch validates its inputs, runs the sandboxed helper for one file op, and returns the parsed result.
// The path is re-validated here (defense-in-depth) before it ever reaches the argv — BuildHelperArgs
// already validates the volume/op/image and refuses anything that could become a host mount. The helper
// itself re-validates and os.Root-confines everything inside the container, so this is the outer of
// several independent layers.
//
// Error contract (nothing leaks host detail to the hub): a context timeout → errOpTimedOut; a clean,
// volume-scoped helper message ("fsd: ...") is surfaced as-is; any other launcher/daemon failure →
// errOpFailed with the real detail logged locally; a malformed helper payload → errOpFailed likewise.
func Launch(ctx context.Context, image, volume, op, path string) ([]protocol.FsEntry, bool, error) {
	if err := validatePath(path); err != nil {
		return nil, false, err
	}
	name := newContainerName()
	args, err := BuildHelperArgs(image, volume, op, path, name)
	if err != nil {
		return nil, false, err
	}
	out, stderr, runErr := runHelper(ctx, args)
	if runErr != nil {
		// The CLI was killed but the daemon-owned container may still be running — reap it by name.
		reapContainer(name)
		if ctx.Err() != nil {
			return nil, false, errOpTimedOut
		}
		if msg, ok := strings.CutPrefix(stderr, "fsd:"); ok {
			return nil, false, &helperError{msg: strings.TrimSpace(msg)}
		}
		fmt.Fprintf(os.Stderr, "fsd: launch %s failed: %v: %s\n", name, runErr, stderr)
		return nil, false, errOpFailed
	}
	var res helperOutput
	if err := json.Unmarshal(out, &res); err != nil {
		fmt.Fprintf(os.Stderr, "fsd: bad helper output from %s: %v\n", name, err)
		return nil, false, errOpFailed
	}
	return res.Entries, res.Truncated, nil
}
