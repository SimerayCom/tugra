// Package logs runs read-only container-log follow sessions the hub asks for.
// A session wraps a fixed-argv `docker logs [--follow] <container>` process (NO arbitrary shell)
// whose stdout+stderr lines are streamed back one at a time. It is cancelable: Close() (from a
// log_stop or a disconnect) kills the process so a `--follow` never leaks.
package logs

import (
	"bufio"
	"context"
	"os/exec"
	"strconv"
	"sync"
)

// Session is a single live `docker logs` follow stream.
type Session struct {
	cmd       *exec.Cmd
	cancel    context.CancelFunc
	closeOnce sync.Once
	reapOnce  sync.Once
	exitCode  int
}

// buildArgs assembles the fixed `docker logs` argv. --timestamps prefixes each line with an RFC3339
// time; --tail bounds the backlog; --follow keeps streaming. target is a resolved container name —
// it is the only external input and rides as a single argv element (no shell, no interpolation).
func buildArgs(target string, tail int, follow bool) []string {
	args := []string{"logs", "--timestamps", "--tail", strconv.Itoa(tail)}
	if follow {
		args = append(args, "--follow")
	}
	return append(args, target)
}

// Start launches `docker logs` for target. onLine receives each output line (stdout+stderr merged)
// as it arrives; onExit fires exactly once when the process ends (naturally, or via Close).
func Start(target string, tail int, follow bool, onLine func(string), onExit func(exitCode int)) (*Session, error) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "docker", buildArgs(target, tail, follow)...)
	return run(cancel, cmd, onLine, onExit)
}

// run wires a prepared command's merged output to onLine and reaps on completion. Split from Start
// so tests can drive it with a controlled command (no docker daemon needed).
func run(cancel context.CancelFunc, cmd *exec.Cmd, onLine func(string), onExit func(exitCode int)) (*Session, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Stderr = cmd.Stdout // merge stderr into the same line stream
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	s := &Session{cmd: cmd, cancel: cancel}
	go func() {
		scanner := bufio.NewScanner(stdout)
		// Raise the max line length well above the 64KB default so a long log line isn't dropped.
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			if onLine != nil {
				onLine(scanner.Text()) // .Text() returns a fresh string (scanner reuses its buffer)
			}
		}
		// Wait only AFTER all reads complete (StdoutPipe requires this ordering).
		code := s.reap()
		if onExit != nil {
			onExit(code)
		}
	}()
	return s, nil
}

// Close cancels the process (idempotent). The reader goroutine then hits EOF, reaps, and fires
// onExit — no zombie `docker logs -f`, no double Wait.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		s.cancel()
	})
}

// reap waits for the process exactly once and caches its exit code (a cancelled/killed follow
// yields a non-zero code, which is expected).
func (s *Session) reap() int {
	s.reapOnce.Do(func() {
		err := s.cmd.Wait()
		if err == nil {
			s.exitCode = 0
		} else if ee, ok := err.(*exec.ExitError); ok {
			s.exitCode = ee.ExitCode()
		} else {
			s.exitCode = -1
		}
	})
	return s.exitCode
}
