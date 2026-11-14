// Package journal is the agent's durable command journal (protocol feature cmd_journal_v1).
//
// The hub drives a deploy by sending ONE long shell command and awaiting its result over the WebSocket. If the
// hub process dies (or the socket drops) while the command runs, the command keeps running here — but nobody is
// listening for its result, and a restarted hub cannot tell what happened. The journal closes that gap:
//
//   - every `durable` command is recorded on disk when it begins (reqId, sha256 of the script, start time) and
//     again when it finishes (exit code, killed flag, head+tail of its output);
//   - a re-sent reqId is never run twice: a still-running one is ignored, a finished one gets its stored result
//     re-sent, one that was running when the agent PROCESS restarted is reported "interrupted";
//   - the hub asks `command_status` and gets `command_state` (running / done / interrupted / unknown) — a
//     read-only answer; the journal never re-executes anything;
//   - results are emitted through a process-level sink that follows the CURRENT connection, so a command started
//     on connection A reports on connection B after a reconnect.
//
// Disk layout: one JSON file per reqId under dir (0700 / 0600), written tmp+fsync+rename so a torn file is
// skipped on load instead of poisoning the registry. Only the script's sha256 is stored, never its text. A
// write failure degrades to memory-only (still correct across hub restarts; not across an agent restart).
package journal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Disposition is what Begin found for a reqId.
type Disposition int

const (
	Fresh       Disposition = iota // never seen → run it
	Running                        // already running here → ignore the duplicate
	Done                           // finished → re-send the stored result
	Interrupted                    // was running when the agent process died → outcome unknown
	Unknown                        // Status only: no entry
)

func (d Disposition) String() string {
	switch d {
	case Running:
		return "running"
	case Done:
		return "done"
	case Interrupted:
		return "interrupted"
	case Fresh:
		return "fresh"
	}
	return "unknown"
}

// Entry is one journaled command.
type Entry struct {
	ReqID      string `json:"reqId"`
	CmdHash    string `json:"cmdHash"`
	StartedAt  int64  `json:"startedAt"`            // unix ms
	FinishedAt int64  `json:"finishedAt,omitempty"` // unix ms; 0 while running
	ExitCode   int    `json:"exitCode"`
	Killed     bool   `json:"killed,omitempty"` // process group killed by a command_cancel (or agent shutdown)
	Output     string `json:"output,omitempty"`
	// Interrupted is set at LOAD time for an entry persisted without FinishedAt: the agent process restarted
	// while it ran, so its outcome is unknown. Never written to disk.
	Interrupted bool `json:"-"`
}

const (
	// Keep at most this many finished entries / this long; a running entry is never evicted.
	maxEntries = 64
	maxAge     = 7 * 24 * time.Hour

	// Output kept per entry: the FIRST headBytes and the LAST tailBytes of the stream, so trailing markers the hub
	// parses (TUGRA_DIGEST, TUGRA_COMMIT, the health-gate verdict) survive even when a build log is huge.
	headBytes = 16 * 1024
	tailBytes = 48 * 1024
)

// Registry is the process-level journal + the live-command table (cancel funcs, output keepers, result sink).
type Registry struct {
	mu      sync.Mutex
	dir     string // "" = memory-only
	entries map[string]*Entry
	cancels map[string]context.CancelFunc
	keepers map[string]*keeper
	sink    func(v any) error
	now     func() time.Time
}

// New opens (or creates) the journal at dir and loads existing entries. dir "" = memory-only (tests, or a host
// with no writable home). Entries persisted without a finish are marked Interrupted. Finished entries beyond the
// count/age caps are pruned on load.
func New(dir string) *Registry {
	r := &Registry{dir: dir, entries: map[string]*Entry{}, cancels: map[string]context.CancelFunc{}, keepers: map[string]*keeper{}, now: time.Now}
	if dir != "" {
		_ = os.MkdirAll(dir, 0o700)
		if files, err := os.ReadDir(dir); err == nil {
			for _, f := range files {
				if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
					continue
				}
				b, err := os.ReadFile(filepath.Join(dir, f.Name()))
				if err != nil {
					continue
				}
				var e Entry
				if json.Unmarshal(b, &e) != nil || e.ReqID == "" || e.StartedAt == 0 {
					_ = os.Remove(filepath.Join(dir, f.Name())) // torn / corrupt → skip and drop
					continue
				}
				if e.FinishedAt == 0 {
					e.Interrupted = true
				}
				r.entries[e.ReqID] = &e
			}
		}
	}
	r.pruneLocked()
	return r
}

// SetSink installs the current connection's send function; results and log chunks of commands started on an
// earlier connection flow here. ClearSink detaches it on disconnect (sends are then dropped, the journal keeps
// the result for the hub's command_status).
func (r *Registry) SetSink(fn func(v any) error) {
	r.mu.Lock()
	r.sink = fn
	r.mu.Unlock()
}

func (r *Registry) ClearSink() { r.SetSink(nil) }

// Send emits v on the current sink; a nil sink (disconnected) drops it silently.
func (r *Registry) Send(v any) error {
	r.mu.Lock()
	fn := r.sink
	r.mu.Unlock()
	if fn == nil {
		return errNoSink
	}
	return fn(v)
}

// Begin records the start of a durable command. Returns Fresh when the caller should run it; otherwise the
// existing entry (Running: ignore; Done: re-send e's result; Interrupted: report unknown outcome).
func (r *Registry) Begin(reqID, command string) (Disposition, *Entry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.entries[reqID]; ok {
		switch {
		case e.Interrupted:
			return Interrupted, e
		case e.FinishedAt == 0:
			return Running, e
		default:
			return Done, e
		}
	}
	e := &Entry{ReqID: reqID, CmdHash: HashCommand(command), StartedAt: r.now().UnixMilli()}
	r.entries[reqID] = e
	r.keepers[reqID] = &keeper{}
	r.persistLocked(e)
	return Fresh, e
}

// Track registers the cancel func of a running command (durable or not) so a command_cancel — possibly on a
// later connection — can kill its process group. Untrack removes it when the command ends.
func (r *Registry) Track(reqID string, cancel context.CancelFunc) {
	r.mu.Lock()
	r.cancels[reqID] = cancel
	r.mu.Unlock()
}

func (r *Registry) Untrack(reqID string) {
	r.mu.Lock()
	delete(r.cancels, reqID)
	r.mu.Unlock()
}

// Cancel kills a tracked running command. Returns false when nothing by that reqId is running here.
func (r *Registry) Cancel(reqID string) bool {
	r.mu.Lock()
	c := r.cancels[reqID]
	r.mu.Unlock()
	if c == nil {
		return false
	}
	c()
	return true
}

// Chunk tees a live output chunk of a durable command into its head+tail keeper.
func (r *Registry) Chunk(reqID, chunk string) {
	r.mu.Lock()
	k := r.keepers[reqID]
	r.mu.Unlock()
	if k != nil {
		k.write(chunk)
	}
}

// Finish records a durable command's end and persists it. The stored output is the keeper's head+tail, so the
// end of the stream always survives.
func (r *Registry) Finish(reqID string, exitCode int, killed bool) *Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.entries[reqID]
	if e == nil {
		return nil
	}
	if k := r.keepers[reqID]; k != nil {
		e.Output = k.String()
		delete(r.keepers, reqID)
	}
	e.ExitCode = exitCode
	e.Killed = killed
	e.FinishedAt = r.now().UnixMilli()
	if e.FinishedAt <= e.StartedAt {
		e.FinishedAt = e.StartedAt + 1
	}
	r.persistLocked(e)
	r.pruneLocked()
	return e
}

// Status answers command_status: the entry (copy) and its disposition. A running entry's Output is the live
// keeper's current content.
func (r *Registry) Status(reqID string) (Entry, Disposition) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.entries[reqID]
	if e == nil {
		return Entry{ReqID: reqID}, Unknown
	}
	cp := *e
	switch {
	case e.Interrupted:
		return cp, Interrupted
	case e.FinishedAt == 0:
		if k := r.keepers[reqID]; k != nil {
			cp.Output = k.String()
		}
		return cp, Running
	}
	return cp, Done
}

// Len reports the number of entries (tests / diagnostics).
func (r *Registry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}

// pruneLocked drops finished/interrupted entries beyond maxEntries (oldest first) or older than maxAge. Running
// entries are never evicted.
func (r *Registry) pruneLocked() {
	cut := r.now().Add(-maxAge).UnixMilli()
	var finished []*Entry
	for _, e := range r.entries {
		if e.FinishedAt == 0 && !e.Interrupted {
			continue
		}
		finished = append(finished, e)
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].StartedAt < finished[j].StartedAt })
	drop := 0
	if len(finished) > maxEntries {
		drop = len(finished) - maxEntries
	}
	for i, e := range finished {
		if i < drop || e.StartedAt < cut {
			delete(r.entries, e.ReqID)
			if r.dir != "" {
				_ = os.Remove(r.path(e.ReqID))
			}
		}
	}
}

func (r *Registry) path(reqID string) string { return filepath.Join(r.dir, SafeName(reqID)+".json") }

// persistLocked writes e atomically (tmp + fsync + rename). Failure is tolerated: the in-memory entry stays
// authoritative for this process (correct across HUB restarts; an agent restart then reports unknown).
func (r *Registry) persistLocked(e *Entry) {
	if r.dir == "" {
		return
	}
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	final := r.path(e.ReqID)
	tmp := final + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return
	}
	_ = f.Sync()
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return
	}
	_ = os.Rename(tmp, final)
}

// SafeName maps a reqId to a filename: reqIds are hub-minted ([A-Za-z0-9_-]) and used verbatim; anything else
// is hashed so a hostile value can never escape the journal directory.
func SafeName(reqID string) string {
	if reqID != "" && len(reqID) <= 128 {
		ok := true
		for _, c := range reqID {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				ok = false
				break
			}
		}
		if ok {
			return reqID
		}
	}
	sum := sha256.Sum256([]byte(reqID))
	return "h_" + hex.EncodeToString(sum[:16])
}

// HashCommand is the only thing stored about a script's content.
func HashCommand(command string) string {
	sum := sha256.Sum256([]byte(command))
	return hex.EncodeToString(sum[:])
}

// keeper keeps the first headBytes and the last tailBytes of a stream.
type keeper struct {
	mu      sync.Mutex
	head    strings.Builder
	tail    []byte // ring of at most tailBytes
	elided  int    // bytes neither in head nor tail
	total   int
	headCap bool
}

func (k *keeper) write(s string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	b := []byte(s)
	k.total += len(b)
	if !k.headCap {
		room := headBytes - k.head.Len()
		if len(b) <= room {
			k.head.Write(b)
			return
		}
		k.head.Write(b[:room])
		b = b[room:]
		k.headCap = true
	}
	k.tail = append(k.tail, b...)
	if over := len(k.tail) - tailBytes; over > 0 {
		k.elided += over
		k.tail = k.tail[over:]
	}
}

func (k *keeper) String() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.headCap {
		return k.head.String()
	}
	if k.elided == 0 {
		return k.head.String() + string(k.tail)
	}
	return k.head.String() + "\n…(" + itoa(k.elided) + " bytes elided by the agent journal)…\n" + string(k.tail)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

type errString string

func (e errString) Error() string { return string(e) }

var errNoSink = errString("journal: no connection to send on")
