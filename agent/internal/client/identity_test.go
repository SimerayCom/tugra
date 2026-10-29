package client

import (
	"testing"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// A valid, enrolled agent must NEVER wipe its identity on a generic or transient rejection — that is
// the self-brick bug: clearing it drops the agent to the enroll path, which cannot succeed against an
// already-enrolled server, so it loops on "rejected" forever. The identity is forgotten ONLY on the
// hub's explicit Code "reenroll".
func TestShouldForgetIdentity(t *testing.T) {
	cases := []struct {
		name     string
		usedAuth bool
		token    string
		resp     protocol.ServerMsg
		want     bool
	}{
		{"explicit reenroll with token", true, "tok", protocol.ServerMsg{Type: "error", Code: "reenroll"}, true},
		// The Oct-2026 incident: a hub restart mid-handshake sent a generic "rejected" with no code. The
		// agent must KEEP its identity and retry, not wipe it.
		{"generic rejection keeps identity", true, "tok", protocol.ServerMsg{Type: "error", Message: "rejected"}, false},
		{"auth-failed (bad signature) keeps identity", true, "tok", protocol.ServerMsg{Type: "error", Message: "auth failed"}, false},
		{"reenroll but no token cannot re-enroll", true, "", protocol.ServerMsg{Type: "error", Code: "reenroll"}, false},
		{"enroll path (no stored identity) never forgets", false, "tok", protocol.ServerMsg{Type: "error", Code: "reenroll"}, false},
		{"empty reply keeps identity", true, "tok", protocol.ServerMsg{}, false},
	}
	for _, c := range cases {
		if got := shouldForgetIdentity(c.usedAuth, c.token, c.resp); got != c.want {
			t.Errorf("%s: shouldForgetIdentity(%v, %q, %+v) = %v, want %v", c.name, c.usedAuth, c.token, c.resp, got, c.want)
		}
	}
}
