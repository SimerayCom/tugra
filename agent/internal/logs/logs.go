// Package logs runs read-only container-log follow sessions the hub asks for.
// A session wraps a fixed-argv `docker logs [--follow] <container>` process (NO arbitrary shell);
// an optional server-side search pipes that output through a fixed-argv `grep -iF` (still no shell).
// Its stdout+stderr lines are streamed back one at a time. It is cancelable: Close() (from a
// log_stop or a disconnect) kills the process(es) so a `--follow` never leaks.
package logs

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"strconv"
	"sync"
)

// Session is a single live `docker logs` follow stream (optionally piped through grep).
type Session struct {
	cmds      []*exec.Cmd // [docker] or [docker, grep]; primary's exit code is reported
	primary   int         // index into cmds whose exit code is the session's (the docker process)
	cancel    context.CancelFunc
	closeOnce sync.Once
	reapOnce  sync.Once
	exitCode  int
}

// buildArgs assembles the fixed `docker logs` argv. --timestamps prefixes each line with an RFC3339
// time; --tail bounds the backlog; --since bounds the window; --follow keeps streaming. target and
// since are the external inputs and ride as single argv elements (no shell, no interpolation).
func buildArgs(target string, tail int, since string, follow bool) []string {
	args := []string{"logs", "--timestamps", "--tail", strconv.Itoa(tail)}
	if since != "" {
		args = append(args, "--since", since)
	}
	if follow {
		args = append(args, "--follow")
	}
	return append(args, target)
}

// Start launches `docker logs` for target (optionally filtered through `grep -iF <search>`). onLine
// receives each output line as it arrives; onExit fires exactly once when the stream ends (naturally
// or via Close). search is passed to grep as a single argv element (`-F` fixed-string, `--` ends
// options) — no shell, no flag/command injection regardless of its content.
func Start(target string, tail int, since string, follow bool, search string, onLine func(string), onExit func(exitCode int)) (*Session, error) {
	ctx, cancel := context.WithCancel(context.Background())
	docker := exec.CommandContext(ctx, "docker", buildArgs(target, tail, since, follow)...)

	if search == "" {
		reader, err := docker.StdoutPipe()
		if err != nil {
			cancel()
			return nil, err
		}
		docker.Stderr = docker.Stdout // merge stderr into the same line stream
		return run(cancel, reader, []*exec.Cmd{docker}, 0, onLine, onExit)
	}

	// docker (stdout+stderr) → grep stdin → scanner reads grep stdout. Two fixed-argv processes.
	grep := exec.CommandContext(ctx, "grep", "--line-buffered", "-iF", "--", search)
	dockerOut, err := docker.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	docker.Stderr = docker.Stdout
	grep.Stdin = dockerOut
	reader, err := grep.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	return run(cancel, reader, []*exec.Cmd{docker, grep}, 0, onLine, onExit)
}

// run starts every command, streams the reader's lines to onLine, then reaps all on completion.
// Split from Start so tests can drive it with controlled commands (no docker daemon needed).
func run(cancel context.CancelFunc, reader io.ReadCloser, cmds []*exec.Cmd, primary int, onLine func(string), onExit func(exitCode int)) (*Session, error) {
	for i, c := range cmds {
		if err := c.Start(); err != nil {
			cancel() // SIGKILL any process already started in the pipe...
			for j := 0; j < i; j++ {
				_ = cmds[j].Wait() // ...and reap it so a partial-start failure leaves no zombie
			}
			return nil, err
		}
	}
	s := &Session{cmds: cmds, primary: primary, cancel: cancel}
	go func() {
		scanner := bufio.NewScanner(reader)
		// Raise the max line length well above the 64KB default so a long log line isn't dropped.
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			if onLine != nil {
				onLine(scanner.Text()) // .Text() returns a fresh string (scanner reuses its buffer)
			}
		}
		// Reads are done (the pipe's read end closed). Cancel BEFORE waiting so any still-running
		// process (e.g. a `docker logs --follow` whose grep filter died first) is killed rather than
		// leaving reap() blocked on it forever. cancel() is idempotent with Close().
		s.cancel()
		code := s.reap()
		if onExit != nil {
			onExit(code)
		}
	}()
	return s, nil
}

// Close cancels the process(es) (idempotent). The reader goroutine then hits EOF, reaps, and fires
// onExit — no zombie `docker logs -f` / grep, no double Wait.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		s.cancel()
	})
}

// reap waits for every command exactly once and caches the primary's exit code (a cancelled/killed
// follow yields a non-zero code, which is expected; grep exit 1 = "no match" is not the reported one).
func (s *Session) reap() int {
	s.reapOnce.Do(func() {
		for i, c := range s.cmds {
			err := c.Wait()
			if i != s.primary {
				continue // reaped to avoid a zombie, but not the reported code
			}
			if err == nil {
				s.exitCode = 0
			} else if ee, ok := err.(*exec.ExitError); ok {
				s.exitCode = ee.ExitCode()
			} else {
				s.exitCode = -1
			}
		}
	})
	return s.exitCode
}
