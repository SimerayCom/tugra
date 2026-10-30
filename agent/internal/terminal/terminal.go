// Package terminal runs interactive PTY sessions (web shell) the hub asks for.
// A session wraps either a host shell or a container shell
// (`docker exec -it <name> …`) attached to a pseudo-terminal so stdin, resize
// and ANSI output all work like a real terminal. It prefers an interactive bash
// when one exists (so Ctrl+A/E/R line-editing and history work), else POSIX sh.
package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sync"

	"github.com/creack/pty"
)

// A container target must be a plain docker name/id: an alphanumeric first char, then [A-Za-z0-9_.-].
// This blocks a leading "-" (which `docker exec` would parse as a flag → option injection) and any
// shell-ish metacharacter. The host shell uses target=="" and skips this.
var targetRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// Prefer an interactive bash when the shell has one (emacs line-editing: Ctrl+A/E/R + history), else fall
// back to POSIX sh. `exec` replaces the process so signals and the PTY attach to the real shell.
const shellCmd = "command -v bash >/dev/null 2>&1 && exec bash || exec sh"

// Session is a single live PTY-backed shell.
type Session struct {
	ptmx      *os.File
	cmd       *exec.Cmd
	closeOnce sync.Once
	reapOnce  sync.Once
	exitCode  int
}

// Start launches a shell on a PTY. target=="" runs a host shell; otherwise it
// execs into that container (target is validated against targetRe first). The
// shell prefers bash and falls back to sh. onData receives raw output bytes as
// they arrive; onExit fires exactly once when the shell ends.
func Start(target string, cols, rows int, onData func([]byte), onExit func(exitCode int)) (*Session, error) {
	var cmd *exec.Cmd
	if target == "" {
		cmd = exec.Command("sh", "-c", shellCmd)
	} else {
		if !targetRe.MatchString(target) {
			return nil, fmt.Errorf("invalid container target %q", target)
		}
		cmd = exec.Command("docker", "exec", "-i", "-t", target, "sh", "-c", shellCmd)
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	winsize := &pty.Winsize{Cols: clampSize(cols, 80), Rows: clampSize(rows, 24)}
	ptmx, err := pty.StartWithSize(cmd, winsize)
	if err != nil {
		return nil, err
	}

	s := &Session{ptmx: ptmx, cmd: cmd}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 && onData != nil {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				onData(chunk)
			}
			if readErr != nil {
				break
			}
		}
		code := s.reap()
		if onExit != nil {
			onExit(code)
		}
	}()
	return s, nil
}

// Write sends stdin bytes to the shell.
func (s *Session) Write(p []byte) (int, error) {
	return s.ptmx.Write(p)
}

// Resize updates the PTY window size.
func (s *Session) Resize(cols, rows int) error {
	return pty.Setsize(s.ptmx, &pty.Winsize{Cols: clampSize(cols, 80), Rows: clampSize(rows, 24)})
}

// Close terminates the shell and releases the PTY (idempotent). The reader
// goroutine then hits EOF, reaps the process and fires onExit — no zombies,
// no double Wait.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
		_ = s.ptmx.Close()
	})
}

// reap waits for the process exactly once and caches its exit code.
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

func clampSize(v, fallback int) uint16 {
	if v <= 0 || v > 1000 {
		return uint16(fallback)
	}
	return uint16(v)
}
