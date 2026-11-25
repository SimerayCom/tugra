//go:build !leaky

package open

import "io"

// leak is the negative-control hook of the canary test. In a normal build it does nothing.
func leak(io.Writer, []byte) {}

// Leaky reports whether this binary was built with the deliberate leak (`-tags leaky`); the tests use it to flip their expectation.
const Leaky = false
