package fsd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	maxHelperJSON   = 1 << 20 // 1 MiB cap on the helper's JSON stdout
	maxHelperStderr = 4 << 10 // 4 KiB cap on captured stderr
)

// limitedBuffer keeps at most max bytes and silently discards the rest (Write always reports success so the
// child process never sees a short write), remembering that it overflowed.
type limitedBuffer struct {
	max      int
	buf      bytes.Buffer
	overflow bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
			l.overflow = true
		} else {
			l.buf.Write(p)
		}
	} else if len(p) > 0 {
		l.overflow = true
	}
	return len(p), nil
}

// runHelper2 executes the helper argv, wiring stdin/stdout, and returns the (capped) trimmed stderr. Package var
// so tests stub the docker invocation without a daemon.
var runHelper2 = func(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer) (stderr string, err error) {
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	if stdin != nil {
		// A non-*os.File stdin makes os/exec run its own copier goroutine, and Go's WaitDelay then closes the
		// pipes but still blocks on that goroutine while the source is stalled in Read. So the child gets a real
		// os.Pipe read end (no os/exec goroutine) and we copy in our own goroutine; both ends are closed on return,
		// so the ctx timeout / WaitDelay always reap the helper even when the source never yields.
		pr, pw, perr := os.Pipe()
		if perr != nil {
			return "", perr
		}
		defer pr.Close()
		defer pw.Close()
		cmd.Stdin = pr
		go func() {
			_, _ = io.Copy(pw, stdin)
			_ = pw.Close() // EOF for the helper once the body is fully copied
		}()
	}
	cmd.Stdout = stdout
	cmd.WaitDelay = 5 * time.Second // bounds the stdout/stderr copy goroutines after the child is killed
	eb := &limitedBuffer{max: maxHelperStderr}
	cmd.Stderr = eb
	err = cmd.Run()
	return strings.TrimSpace(eb.buf.String()), err
}

// Result2 is the parsed outcome of one fs2 helper run.
type Result2 struct {
	Stat    *protocol.FsStat
	Bytes   int64
	Sha256  string
	Etag    string
	Created bool
}

var helperErrRe = regexp.MustCompile(`(?m)^fsd: \[([a-z_]+)\] (.*)$`)

// parseHelperErr extracts the typed "fsd: [code] msg" line from helper stderr.
func parseHelperErr(stderr string) (*Error, bool) {
	m := helperErrRe.FindStringSubmatch(stderr)
	if m == nil {
		return nil, false
	}
	return &Error{Code: m[1], Msg: strings.TrimSpace(m[2])}, true
}

// Launch2 runs one fs2 op in the sandboxed helper. For `read` the file bytes stream into stdout (no JSON); every
// other op prints one JSON object that is captured (1 MiB cap) and parsed. For `write`, stdin carries exactly
// r.Size bytes. Error contract (nothing host-side leaks to the hub): a context timeout -> errOpTimedOut; a typed
// helper message -> *Error; anything else -> errOpFailed with the detail logged locally only. Any runner error
// reaps the daemon-owned container by name (the CLI kill alone would leave it running).
func Launch2(ctx context.Context, image, volume string, r Req2, stdin io.Reader, stdout io.Writer) (Result2, error) {
	name := newContainerName()
	args, needsStdin, err := BuildHelperArgs2(image, volume, r, name)
	if err != nil {
		return Result2{}, &Error{Code: CodeBadRequest, Msg: err.Error()}
	}
	var in io.Reader
	if needsStdin {
		if stdin == nil {
			return Result2{}, &Error{Code: CodeBadRequest, Msg: "missing body"}
		}
		in = stdin
	}
	var jsonOut *limitedBuffer
	var out io.Writer
	if r.Op == "read" {
		if stdout == nil {
			return Result2{}, &Error{Code: CodeBadRequest, Msg: "missing sink"}
		}
		out = stdout
	} else {
		jsonOut = &limitedBuffer{max: maxHelperJSON}
		out = jsonOut
	}
	stderr, runErr := runHelper2(ctx, args, in, out)
	if runErr != nil {
		reapContainer(name)
		if ctx.Err() != nil {
			return Result2{}, errOpTimedOut
		}
		if te, ok := parseHelperErr(stderr); ok {
			return Result2{}, te
		}
		fmt.Fprintf(os.Stderr, "fsd2: launch %s failed: %v: %s\n", name, runErr, stderr)
		return Result2{}, errOpFailed
	}
	if jsonOut == nil {
		return Result2{}, nil
	}
	if jsonOut.overflow {
		fmt.Fprintf(os.Stderr, "fsd2: helper output from %s exceeded %d bytes\n", name, maxHelperJSON)
		return Result2{}, errOpFailed
	}
	var o cli2Output
	if err := json.Unmarshal(jsonOut.buf.Bytes(), &o); err != nil {
		fmt.Fprintf(os.Stderr, "fsd2: bad helper output from %s: %v\n", name, err)
		return Result2{}, errOpFailed
	}
	return Result2{Stat: o.Stat, Bytes: o.Bytes, Sha256: o.Sha256, Etag: o.Etag, Created: o.Created}, nil
}

// IsTimeout reports whether err is the stable file-op timeout.
func IsTimeout(err error) bool { return errors.Is(err, errOpTimedOut) }
