// Package dockerstats collects per-container resource usage via `docker stats`.
package dockerstats

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/mrcandev/tugra/agent/internal/protocol"
)

const (
	statsTimeout  = 20 * time.Second
	maxContainers = 200 // cap so a runaway host can't flood the hub with a huge batch
)

// statsLine is one line of `docker stats --format '{{json .}}'`.
type statsLine struct {
	ID       string `json:"ID"`
	Name     string `json:"Name"`
	CPUPerc  string `json:"CPUPerc"`  // "0.15%"
	MemUsage string `json:"MemUsage"` // "10.5MiB / 1.9GiB"
	MemPerc  string `json:"MemPerc"`  // "0.55%"
	NetIO    string `json:"NetIO"`    // "1.2kB / 3.4MB"  (cumulative rx / tx)
	BlockIO  string `json:"BlockIO"`  // "0B / 8.19kB"    (cumulative read / write)
}

type cumulative struct {
	netRx, netTx, blkRead, blkWrite float64
}

// Collector runs `docker stats` and derives net/block RATES from successive samples. Not safe for
// concurrent use — call Sample from a single goroutine; a reentrancy guard drops overlapping calls
// (a slow `docker stats` shouldn't pile up) rather than blocking.
type Collector struct {
	prev     map[string]cumulative // keyed by container NAME (stable across restarts)
	prevTime time.Time
	hasPrev  bool
	inFlight bool
}

// NewCollector returns a Collector whose first Sample reports zero net/block rates.
func NewCollector() *Collector { return &Collector{prev: map[string]cumulative{}} }

// Sample runs `docker stats --no-stream` once and returns each container's usage, filling
// net/block with the byte/s rate since the previous call (a container's first appearance, and the
// very first sample, report 0). Returns (nil, nil) if a previous Sample is still running.
func (c *Collector) Sample(ctx context.Context) ([]protocol.ContainerStat, error) {
	if c.inFlight {
		return nil, nil // a still-running collection — skip this tick
	}
	c.inFlight = true
	defer func() { c.inFlight = false }()

	cctx, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()
	// Fixed argv (no shell) — nothing external can ever reach the command line here.
	out, err := exec.CommandContext(cctx, "docker", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}").Output()
	if err != nil {
		return nil, err
	}
	return c.ingest(out, time.Now()), nil
}

// ingest parses one `docker stats` payload, derives net/block rates against the previous sample,
// and advances the collector's state. Split out from Sample so the parse/rate logic is testable
// without a docker daemon.
func (c *Collector) ingest(out []byte, now time.Time) []protocol.ContainerStat {
	elapsed := 0.0
	if c.hasPrev {
		elapsed = now.Sub(c.prevTime).Seconds()
	}

	next := make(map[string]cumulative)
	stats := make([]protocol.ContainerStat, 0)
	truncated := false
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var d statsLine
		if json.Unmarshal([]byte(line), &d) != nil {
			continue // skip a malformed line rather than drop the whole batch
		}
		memUsed, memTotal := parseUsage(d.MemUsage)
		curRx, curTx := parseUsage(d.NetIO)
		curRead, curWrite := parseUsage(d.BlockIO)
		cur := cumulative{netRx: curRx, netTx: curTx, blkRead: curRead, blkWrite: curWrite}
		// Advance the rate baseline for EVERY parsed container, even past the cap — otherwise a
		// container pushed beyond the first maxContainers loses its cumulative baseline and its
		// next/block rate silently reads 0 when it re-enters the emitted set (docker's line order
		// is not stable). The cap bounds only the EMITTED batch, not the baseline map.
		next[d.Name] = cur
		if len(stats) >= maxContainers {
			truncated = true
			continue
		}

		s := protocol.ContainerStat{
			ID:       d.ID,
			Name:     d.Name,
			CPU:      parsePct(d.CPUPerc),
			MemUsed:  memUsed,
			MemTotal: memTotal,
			MemPct:   parsePct(d.MemPerc),
		}
		if p, ok := c.prev[d.Name]; ok && elapsed > 0 {
			s.NetRx = rate(p.netRx, cur.netRx, elapsed)
			s.NetTx = rate(p.netTx, cur.netTx, elapsed)
			s.BlkRead = rate(p.blkRead, cur.blkRead, elapsed)
			s.BlkWrite = rate(p.blkWrite, cur.blkWrite, elapsed)
		}
		stats = append(stats, s)
	}
	if truncated {
		log.Printf("dockerstats: more than %d containers, batch truncated", maxContainers)
	}
	c.prev, c.prevTime, c.hasPrev = next, now, true
	return stats
}

// rate turns cumulative byte counters into a per-second rate. A counter reset (a container restart
// zeroes its cumulative → cur < prev) yields 0, not a bogus negative/spike.
func rate(prev, cur, elapsed float64) float64 {
	if elapsed <= 0 || cur < prev {
		return 0
	}
	return (cur - prev) / elapsed
}

// parsePct parses docker's "0.15%" into 0.15.
func parsePct(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	return f
}

// parseUsage splits docker's "A / B" pair (mem "used / total", net "rx / tx", block "read / write")
// into two byte values.
func parseUsage(s string) (float64, float64) {
	parts := strings.SplitN(s, "/", 2)
	if len(parts) != 2 {
		return 0, 0
	}
	return parseBytes(parts[0]), parseBytes(parts[1])
}

// parseBytes parses a docker size string into bytes. Docker mixes SI (kB/MB/GB/TB — network & block
// IO) and binary (KiB/MiB/GiB/TiB — memory) units, so both families are handled; an "i" in the unit
// (e.g. MiB) selects the 1024 base.
func parseBytes(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	i := 0
	for i < len(s) && (s[i] == '.' || s[i] == '-' || (s[i] >= '0' && s[i] <= '9')) {
		i++
	}
	num, err := strconv.ParseFloat(s[:i], 64)
	if err != nil {
		return 0
	}
	unit := strings.ToLower(strings.TrimSpace(s[i:]))
	mult := 1000.0
	if strings.Contains(unit, "i") { // KiB / MiB / GiB / TiB
		mult = 1024.0
	}
	switch {
	case strings.HasPrefix(unit, "k"):
		return num * mult
	case strings.HasPrefix(unit, "m"):
		return num * mult * mult
	case strings.HasPrefix(unit, "g"):
		return num * mult * mult * mult
	case strings.HasPrefix(unit, "t"):
		return num * mult * mult * mult * mult
	case strings.HasPrefix(unit, "p"):
		return num * mult * mult * mult * mult * mult
	default: // "b" or empty
		return num
	}
}
