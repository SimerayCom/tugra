package drains

import (
	"context"
	"sort"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	statusInterval = 30 * time.Second
	statusDebounce = time.Second
)

// notifyChange signals the status loop that something changed (non-blocking; coalesced).
func (f *Forwarder) notifyChange() {
	select {
	case f.changed <- struct{}{}:
	default:
	}
}

// Status returns the current per-sink status: live sinks plus drains that could not be built ("invalid").
func (f *Forwarder) Status() []protocol.DrainStatus {
	f.mu.Lock()
	sinks := make([]*sink, 0, len(f.sinks))
	for _, s := range f.sinks {
		sinks = append(sinks, s)
	}
	invalid := make(map[string]string, len(f.invalid))
	for id, c := range f.invalid {
		invalid[id] = c
	}
	f.mu.Unlock()
	out := make([]protocol.DrainStatus, 0, len(sinks)+len(invalid))
	for _, s := range sinks {
		out = append(out, s.status())
	}
	for id, c := range invalid {
		out = append(out, protocol.DrainStatus{ID: id, State: "invalid", ErrClass: c})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (f *Forwarder) stopStatusLocked() {
	if f.statCtx != nil {
		f.statCtx()
		f.statCtx = nil
	}
}

func (f *Forwarder) startStatusLocked(parent context.Context) {
	if f.report == nil || f.statCtx != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	f.statCtx = cancel
	go f.statusLoop(ctx)
}

// statusLoop reports every 30 s and, debounced by 1 s, whenever a sink's state changes or the drain set changes.
func (f *Forwarder) statusLoop(ctx context.Context) {
	t := time.NewTicker(statusInterval)
	defer t.Stop()
	send := func() {
		f.report(protocol.DrainStatusMsg{Type: "drain_status", Drains: f.Status()})
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			send()
		case <-f.changed:
			select {
			case <-ctx.Done():
				return
			case <-time.After(statusDebounce):
			}
			send()
		}
	}
}
