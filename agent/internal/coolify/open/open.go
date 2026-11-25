// Package open is the `coolify-open` helper: it runs inside a short-lived container with no network, a read-only root filesystem, no
// volumes and no environment (see the golden argv in the parent package). It reads the app key and the still-encrypted rows from stdin,
// decrypts each value in memory and seals it at once to the hub's per-run key; stdout carries only sealed envelopes or fixed codes.
//
// Keep this package's imports small and free of anything that can open a socket or start a process: the dependency test in the parent
// package fails if net, net/http or os/exec ever appear in its closure.
package open

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/coolify/laravel"
	"github.com/SimerayCom/tugra/agent/internal/coolify/seal"
)

// Limits shared with the agent side.
const (
	MaxLineBytes = 4 << 20
	MaxRows      = 100000
)

// KeyLine is the first stdin line: the key material, never put on argv, env or disk.
type KeyLine struct {
	Key  string `json:"key"`
	Prev string `json:"prev"`
}

// Row is one stored value as it came out of Coolify's database.
type Row struct {
	Ref     string `json:"ref"`
	Field   string `json:"field"`
	Class   string `json:"class"`
	Form    string `json:"form"` // serialized | string | auto | plain
	PlainOK bool   `json:"plainOK"`
	V       string `json:"v"`
}

// Out is one stdout line: sealed, or a fixed code. Never plaintext, never a message.
type Out struct {
	Ref   string `json:"ref"`
	Field string `json:"field"`
	Class string `json:"class,omitempty"`
	Env   string `json:"env,omitempty"`
	Code  string `json:"code,omitempty"`
}

const codeKeyPrev = "key_prev"

// RunCLI parses `--run= --server= --recipient=` and serves stdin to stdout. It returns the process exit code.
func RunCLI(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	return Run(args, stdin, stdout, stderr, rand.Reader)
}

// Run is RunCLI with the randomness source injected (tests use a fixed one).
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer, rnd io.Reader) int {
	var runID, serverID, recipientB64 string
	for _, a := range args {
		switch {
		case strings.HasPrefix(a, "--run="):
			runID = strings.TrimPrefix(a, "--run=")
		case strings.HasPrefix(a, "--server="):
			serverID = strings.TrimPrefix(a, "--server=")
		case strings.HasPrefix(a, "--recipient="):
			recipientB64 = strings.TrimPrefix(a, "--recipient=")
		default:
			fmt.Fprintln(stderr, "coolify-open: usage")
			return 2
		}
	}
	if !validID(runID) || !validID(serverID) {
		fmt.Fprintln(stderr, "coolify-open: bad run or server id")
		return 2
	}
	recipient, err := seal.ParseRecipient(recipientB64)
	if err != nil {
		fmt.Fprintln(stderr, "coolify-open: bad recipient key")
		return 2
	}

	rd := bufio.NewReaderSize(stdin, 64<<10)
	first, err := readLine(rd)
	if err != nil {
		fmt.Fprintln(stderr, "coolify-open: no key line")
		return 2
	}
	var kl KeyLine
	dec := json.NewDecoder(strings.NewReader(string(first)))
	dec.DisallowUnknownFields()
	if dec.Decode(&kl) != nil {
		fmt.Fprintln(stderr, "coolify-open: bad key line")
		return 2
	}
	ring := laravel.ParseKeyRing(kl.Key, kl.Prev)
	defer ring.Zero()
	kl = KeyLine{}
	wipe(first)

	enc := json.NewEncoder(stdout)
	prevReported := false
	for n := 0; ; n++ {
		line, err := readLine(rd)
		if err == io.EOF {
			return 0
		}
		if err != nil || n >= MaxRows {
			fmt.Fprintln(stderr, "coolify-open: input too large")
			return 2
		}
		var row Row
		d := json.NewDecoder(strings.NewReader(string(line)))
		d.DisallowUnknownFields()
		derr := d.Decode(&row)
		wipe(line)
		if derr != nil || !validRow(row) {
			fmt.Fprintln(stderr, "coolify-open: bad row")
			return 2
		}
		o, usedPrev := handle(stderr, ring, rnd, recipient, runID, serverID, row)
		if enc.Encode(o) != nil {
			return 2
		}
		if usedPrev && !prevReported {
			prevReported = true
			if enc.Encode(Out{Ref: row.Ref, Field: "*", Code: codeKeyPrev}) != nil {
				return 2
			}
		}
	}
}

func handle(stderr io.Writer, ring *laravel.KeyRing, rnd io.Reader, recipient []byte, runID, serverID string, row Row) (Out, bool) {
	o := Out{Ref: row.Ref, Field: row.Field}
	form := laravel.FormString
	switch row.Form {
	case "serialized":
		form = laravel.FormSerialized
	case "auto":
		form = laravel.FormAuto
	}
	var res laravel.Result
	if row.Form == "plain" {
		// A column Coolify stores as readable text (a compose file, a task command): nothing to decrypt, only to seal.
		res = laravel.Result{Plain: []byte(row.V), WasPlaintext: true}
	} else {
		var err error
		if res, err = ring.Open(row.V, form, row.PlainOK); err != nil {
			o.Code = laravel.CodeOf(err)
			return o, false
		}
	}
	defer wipe(res.Plain)
	leak(stderr, res.Plain) // no-op in a normal build; the `leaky` build tag writes the plaintext out so the canary test has something to catch
	env, err := seal.Seal(rnd, recipient, seal.Context{RunID: runID, ServerID: serverID, Ref: row.Ref, Field: row.Field, Class: row.Class}, res.Plain)
	if err != nil {
		if err == seal.ErrTooLarge {
			o.Code = laravel.CodeTooLarge
		} else {
			o.Code = laravel.CodeBadPayload
		}
		return o, false
	}
	o.Class, o.Env = row.Class, env
	return o, res.UsedPrevious
}

func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// readLine returns one line without its newline. A line over MaxLineBytes is an error (the agent never sends one).
func readLine(rd *bufio.Reader) ([]byte, error) {
	var out []byte
	for {
		chunk, isPrefix, err := rd.ReadLine()
		if err != nil {
			if err == io.EOF && len(out) > 0 {
				return out, nil
			}
			return nil, err
		}
		out = append(out, chunk...)
		if len(out) > MaxLineBytes {
			return nil, io.ErrShortBuffer
		}
		if !isPrefix {
			return out, nil
		}
	}
}

func validID(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func validToken(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == ':' || c == '.') {
			return false
		}
	}
	return true
}

func validRow(r Row) bool {
	if !validToken(r.Ref, 100) || !validToken(r.Field, 64) || !validToken(r.Class, 32) {
		return false
	}
	switch r.Form {
	case "serialized", "string", "auto", "plain":
		return true
	}
	return false
}
