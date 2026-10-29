package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/keys"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// rejectHub is a fake hub that sends a challenge, reads the agent's first message, then rejects it with
// the given message + optional code.
func rejectHub(t *testing.T, message, code string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		ctx := r.Context()
		_ = wsjson.Write(ctx, c, map[string]any{"type": "challenge", "nonce": "n1"})
		var first map[string]any
		if err := wsjson.Read(ctx, c, &first); err != nil {
			return
		}
		reply := map[string]any{"type": "error", "message": message}
		if code != "" {
			reply["code"] = code
		}
		_ = wsjson.Write(ctx, c, reply)
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// runReject dials a fake hub that rejects, as an already-enrolled agent, and returns the error plus the
// serverId STILL ON DISK afterwards (the brick-safety invariant: a reject must never erase it).
func runReject(t *testing.T, message, code string) (error, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.json")
	store, _ := config.LoadStore(path)
	store.ServerID = "s1"
	store.Seal = "seal1"
	if err := store.Save(); err != nil {
		t.Fatalf("seed store: %v", err)
	}
	cfg := config.Config{HubURL: rejectHub(t, message, code), Token: "tok"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := runOnce(ctx, cfg, keys.New(), store, nil, false)
	reloaded, _ := config.LoadStore(path)
	return err, reloaded.ServerID
}

// A generic/transient rejection (no code) must KEEP the identity and must NOT signal a re-enroll.
func TestRunOnceGenericRejectKeepsIdentity(t *testing.T) {
	err, serverID := runReject(t, "rejected", "")
	if err == nil {
		t.Fatal("expected a rejection error")
	}
	if errors.Is(err, errStaleIdentity) {
		t.Fatal("a generic reject must NOT request re-enroll")
	}
	if serverID != "s1" {
		t.Fatalf("identity wiped on a generic reject (serverID=%q) — this is the self-brick", serverID)
	}
}

// An explicit "reenroll" signal requests a re-enroll retry but STILL must not erase the identity on disk
// (it is overwritten only when a fresh enroll succeeds, which this hub never grants).
func TestRunOnceReenrollKeepsIdentityUntilEnrollSucceeds(t *testing.T) {
	err, serverID := runReject(t, "reenroll", "reenroll")
	if !errors.Is(err, errStaleIdentity) {
		t.Fatalf("an explicit reenroll code must signal errStaleIdentity, got %v", err)
	}
	if serverID != "s1" {
		t.Fatalf("identity wiped before a replacement enroll succeeded (serverID=%q)", serverID)
	}
}
