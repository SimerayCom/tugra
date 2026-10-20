// Package exec runs shell commands the hub asks the agent to execute.
// (Capability scopes / allowlists are a P1 hardening — see GUVENLIK-MIMARISI.)
package exec

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxOutput = 64 * 1024

type Result struct {
	ExitCode int
	Output   string
}

// chunkWriter fans combined stdout+stderr out to a live callback (uncapped, for
// real-time streaming) while also accumulating a capped copy for Result.Output.
type chunkWriter struct {
	mu      sync.Mutex
	onChunk func(string)
	buf     strings.Builder
	total   int
	capped  bool
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.onChunk != nil {
		w.onChunk(string(p))
	}
	if w.total < maxOutput {
		room := maxOutput - w.total
		if len(p) <= room {
			w.buf.Write(p)
			w.total += len(p)
		} else {
			w.buf.Write(p[:room])
			w.total += room
			w.buf.WriteString("\n…(truncated)")
			w.capped = true
		}
	}
	return len(p), nil
}

// Run executes `command` via `sh -c`, capturing combined stdout+stderr.
func Run(ctx context.Context, command string, timeout time.Duration) Result {
	return RunStreaming(ctx, command, timeout, nil)
}

// RunStreaming is like Run but also invokes onChunk for each write of the
// command's combined output as it is produced (live streaming). onChunk may be
// nil. The returned Result.Output is capped at maxOutput; the live stream is not.
func RunStreaming(ctx context.Context, command string, timeout time.Duration, onChunk func(string)) Result {
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(c, "sh", "-c", command)
	// Run in its own process group and kill the whole group on timeout/cancel; otherwise only `sh`
	// dies and its docker/git children linger holding the output pipes. WaitDelay force-closes the
	// pipes if a straggler still holds them after the kill.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	cw := &chunkWriter{onChunk: onChunk}
	cmd.Stdout = cw
	cmd.Stderr = cw

	err := cmd.Run()
	out := cw.buf.String()

	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
			tail := "\n" + err.Error()
			out += tail
			if onChunk != nil {
				onChunk(tail)
			}
		}
	}
	return Result{ExitCode: code, Output: out}
}
