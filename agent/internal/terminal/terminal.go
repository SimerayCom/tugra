// Package terminal runs interactive PTY sessions (web shell) the hub asks for.
// A session wraps either a host shell (`sh`) or a container shell
// (`docker exec -it <name> sh`) attached to a pseudo-terminal so stdin, resize
// and ANSI output all work like a real terminal.
package terminal

import (
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// Session is a single live PTY-backed shell.
type Session struct {
	ptmx      *os.File
	cmd       *exec.Cmd
	closeOnce sync.Once
	reapOnce  sync.Once
	exitCode  int
}

// Start launches a shell on a PTY. target=="" runs the host `sh`; otherwise it
// runs `docker exec -it <target> sh` for that container. onData receives raw
// output bytes as they arrive; onExit fires exactly once when the shell ends.
func Start(target string, cols, rows int, onData func([]byte), onExit func(exitCode int)) (*Session, error) {
	var cmd *exec.Cmd
	if target == "" {
		cmd = exec.Command("sh")
	} else {
		cmd = exec.Command("docker", "exec", "-i", "-t", target, "sh")
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
