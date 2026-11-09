// Package traffic turns the proxy's JSON access log into privacy-preserving per-domain traffic
// summaries. It tails the log, parses and filters the records, aggregates them per window and (optionally)
// resolves the visitor country locally. Raw client addresses never leave this package: only counts and
// ISO country codes are put into the summary that is pushed to the hub.
package traffic

import (
	"bytes"
	"os"
)

const (
	// chunkSize is how much of the log is read at a time and streamed into the aggregator, so memory use
	// is independent of how much was appended since the last pass.
	chunkSize = 256 << 10
	// maxTickBytes is a backstop, not a throughput cap: one pass will not consume more than this many
	// bytes of backlog. A larger backlog skips ahead to the newest bytes (the oldest are dropped and
	// counted in `dropped`). At roughly 550 bytes per line this is on the order of a million requests.
	maxTickBytes = 512 << 20
	// maxTickLines is a per-pass work bound. Lines past it are NOT dropped: they stay in the file and are
	// read by the next pass (and only fall under the byte backstop if the backlog keeps growing).
	maxTickLines = 5000000
	// maxPartialBytes bounds a single unterminated line held while waiting for its newline.
	maxPartialBytes = 1 << 20
)

// tailer follows one append-only log file by byte offset. It survives the file being missing (the
// feature is off), replaced (rotation by rename) and truncated in place (copytruncate).
type tailer struct {
	path     string
	maxBytes int
	maxLines int

	offset   int64 // start of the first unconsumed line
	info     os.FileInfo
	skipToNL bool   // discard bytes up to and including the next newline (we jumped into a line)
	dropped  int64  // spans dropped to stay within bounds (diagnostic)
	chunk    []byte // reused read buffer
	pending  []byte // reused buffer for a line that spans chunks
}

// newTailer starts at the END of an existing file (history is never replayed, so a reconnect cannot
// double-count) and at the START of a file that does not exist yet.
func newTailer(path string) *tailer {
	t := &tailer{path: path, maxBytes: maxTickBytes, maxLines: maxTickLines}
	if st, err := os.Stat(path); err == nil && !st.IsDir() {
		t.info = st
		t.offset = st.Size()
	}
	return t
}

// readLines returns copies of the complete new lines since the previous call.
func (t *tailer) readLines() [][]byte {
	var lines [][]byte
	t.forEachLine(func(l []byte) { lines = append(lines, append([]byte(nil), l...)) })
	return lines
}

// forEachLine streams the complete new lines since the previous call to fn. The slice is only valid
// during the call. It never returns an error: a missing or unreadable file simply yields nothing, so an
// idle collector costs one failed open per tick. A trailing unterminated line is left in the file and
// re-read by the next pass.
func (t *tailer) forEachLine(fn func(line []byte)) {
	f, err := os.Open(t.path)
	if err != nil {
		// Traffic Analytics off (or file mid-rotation): forget the old file so a new one starts at 0.
		t.info = nil
		t.offset = 0
		t.skipToNL = false
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return
	}

	switch {
	case t.info == nil:
		// A file appearing after we were started (or after a missing spell): read it from its start.
		t.offset = 0
		t.skipToNL = false
	case !os.SameFile(t.info, st), st.Size() < t.offset:
		// Replaced, or truncated in place by copytruncate: start over from the top.
		t.offset = 0
		t.skipToNL = false
	}
	t.info = st

	size := st.Size()
	if size <= t.offset {
		return
	}
	if size-t.offset > int64(t.maxBytes) {
		// Backlog beyond the backstop: keep only the newest bytes and resynchronise on the next newline.
		t.offset = size - int64(t.maxBytes)
		t.skipToNL = true
		t.dropped++
	}
	if t.chunk == nil {
		t.chunk = make([]byte, chunkSize)
	}

	readPos := t.offset   // next file byte to read
	lineStart := t.offset // file offset of the first byte not yet consumed as a whole line
	pending := t.pending[:0]
	lines := 0
	defer func() { t.pending = pending[:0] }()

	for readPos < size {
		want := int64(len(t.chunk))
		if size-readPos < want {
			want = size - readPos
		}
		n, _ := f.ReadAt(t.chunk[:want], readPos) // a short read (racing truncate) is fine: the next pass re-syncs
		if n <= 0 {
			break
		}
		base := readPos
		readPos += int64(n)
		data := t.chunk[:n]
		for len(data) > 0 {
			i := bytes.IndexByte(data, '\n')
			if i < 0 {
				switch {
				case t.skipToNL:
					// still inside the line we are discarding
				case len(pending)+len(data) > maxPartialBytes:
					t.skipToNL = true // pathological unterminated line: drop it, resync at its newline
					t.dropped++
					pending = pending[:0]
				default:
					pending = append(pending, data...)
				}
				break
			}
			if t.skipToNL {
				t.skipToNL = false
				pending = pending[:0]
			} else {
				line := data[:i]
				if len(pending) > 0 {
					pending = append(pending, line...)
					line = pending
				}
				line = bytes.TrimSuffix(line, []byte{'\r'})
				if len(line) > 0 {
					if lines >= t.maxLines {
						t.offset = lineStart // leave the rest for the next pass
						return
					}
					lines++
					fn(line)
				}
				pending = pending[:0]
			}
			data = data[i+1:]
			lineStart = base + int64(n) - int64(len(data))
		}
	}
	if t.skipToNL {
		t.offset = readPos // inside a discarded line: nothing to re-read
	} else {
		t.offset = lineStart // an unterminated tail stays in the file for the next pass
	}
}
