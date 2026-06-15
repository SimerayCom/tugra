// Package exec runs shell commands the hub asks the agent to execute.
// (Capability scopes / allowlists are a P1 hardening — see GUVENLIK-MIMARISI.)
package exec

import (
	"bytes"
	"context"
	"os/exec"
	"time"
)

const maxOutput = 64 * 1024

type Result struct {
	ExitCode int
	Output   string
}

// Run executes `command` via `sh -c`, capturing combined stdout+stderr.
func Run(ctx context.Context, command string, timeout time.Duration) Result {
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(c, "sh", "-c", command)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	err := cmd.Run()
	out := buf.String()
	if len(out) > maxOutput {
		out = out[:maxOutput] + "\n…(truncated)"
	}

	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
			out += "\n" + err.Error()
		}
	}
	return Result{ExitCode: code, Output: out}
}
