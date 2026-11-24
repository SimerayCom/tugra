package migrate

import (
	"fmt"
	"time"
)

// dumpProgressLine is the one line a streamed dump logs per committed part: how much is dumped, the share of the expected total
// (a measured size, so the percentage is capped at 99 until the dump really ends), the compressed rate and the time left at the
// average raw rate so far. With no known total it says only what is done. Pure: no clock, no I/O.
func dumpProgressLine(part int, rawDone, rawTotal, committed int64, elapsed time.Duration) string {
	secs := elapsed.Seconds()
	rate := 0.0
	if secs > 0 {
		rate = float64(committed) / secs / 1e6
	}
	if rawTotal <= 0 {
		return fmt.Sprintf("  part %d  %.2f GiB dumped  (%.1f MB/s compressed)", part, float64(rawDone)/(1<<30), rate)
	}
	pct := int(float64(rawDone) / float64(rawTotal) * 100)
	if pct > 99 {
		pct = 99
	}
	left := ""
	if rawDone > 0 && secs > 0 && rawDone < rawTotal {
		rawRate := float64(rawDone) / secs
		left = ", about " + humanLeft(time.Duration(float64(rawTotal-rawDone)/rawRate*float64(time.Second))) + " left"
	}
	return fmt.Sprintf("  part %d  %.2f GiB dumped of about %.2f GiB  (%d%%%s, %.1f MB/s compressed)", part, float64(rawDone)/(1<<30), float64(rawTotal)/(1<<30), pct, left, rate)
}

// humanLeft rounds a duration to something a person reads at a glance: seconds under a minute, minutes under two hours, else hours.
func humanLeft(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d s", int(d.Seconds())+1)
	case d < 2*time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes())+1)
	default:
		return fmt.Sprintf("%.1f h", d.Hours())
	}
}

// spoolRoomLine is the source-side disk preflight of a streamed dump, as one operator-readable line. The dump itself never needs source
// disk (it is read as fast as it is uploaded); the spool only lets the dump client run ahead of a stalled upload, so a small spool
// is slower, never wrong. Returns the line and whether it is a warning. Pure: free is the probe's answer, ok=false when it failed.
func spoolRoomLine(dir string, free uint64, ok bool, capBytes, marginBytes int64) (string, bool) {
	if !ok {
		return fmt.Sprintf("source spool: the free space of %s could not be read; the dump runs, and waits for the upload when the spool fills", dir), true
	}
	usable := int64(free) - marginBytes
	if usable < 0 {
		usable = 0
	}
	room := usable
	if capBytes > 0 && capBytes < room {
		room = capBytes
	}
	if room < 256*mib {
		return fmt.Sprintf("source spool: only %.1f GiB free in %s; the dump is read only as fast as it is uploaded (slower, still complete). Free some space there for a faster copy", float64(free)/(1<<30), dir), true
	}
	return fmt.Sprintf("source spool: %.1f GiB free in %s; the dump may read ahead of the upload by up to %.1f GiB", float64(free)/(1<<30), dir, float64(room)/(1<<30)), false
}
