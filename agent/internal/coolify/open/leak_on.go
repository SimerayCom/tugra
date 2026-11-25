//go:build leaky

package open

import "io"

// leak writes the plaintext to the helper's stderr. It exists ONLY so the canary leak test can prove it detects a leak: under
// `-tags leaky` that test must SEE the plaintext. Never build the agent with this tag.
func leak(w io.Writer, p []byte) { _, _ = w.Write(append(append([]byte("leak:"), p...), '\n')) }

// Leaky reports whether this binary was built with the deliberate leak.
const Leaky = true
