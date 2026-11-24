package migrate

import (
	"strings"
	"testing"
	"time"
)

func TestDumpProgressLine(t *testing.T) {
	const gib = int64(1 << 30)
	t.Run("a known total gives a percentage and the time left at the average rate", func(t *testing.T) {
		// 1 GiB of 4 GiB in 100 s: 3 GiB left at 1 GiB per 100 s is 300 s, shown as 6 min
		got := dumpProgressLine(8, gib, 4*gib, gib/2, 100*time.Second)
		for _, want := range []string{"part 8", "1.00 GiB dumped of about 4.00 GiB", "25%", "about 6 min left", "MB/s compressed"} {
			if !strings.Contains(got, want) {
				t.Errorf("line %q lacks %q", got, want)
			}
		}
	})
	t.Run("the share never reaches 100 before the dump ends, and no time is promised past the total", func(t *testing.T) {
		got := dumpProgressLine(9, 5*gib, 4*gib, gib, 50*time.Second)
		if !strings.Contains(got, "99%") || strings.Contains(got, "left") {
			t.Errorf("an overshoot must read 99%% and promise no time: %q", got)
		}
	})
	t.Run("without a total it says only what is done", func(t *testing.T) {
		got := dumpProgressLine(2, gib, 0, gib/2, 10*time.Second)
		if strings.Contains(got, "%") || strings.Contains(got, "left") || !strings.Contains(got, "1.00 GiB dumped") {
			t.Errorf("unexpected line %q", got)
		}
	})
	t.Run("no elapsed time gives no rate and no estimate", func(t *testing.T) {
		got := dumpProgressLine(1, gib, 4*gib, gib, 0)
		if strings.Contains(got, "left") || !strings.Contains(got, "0.0 MB/s") {
			t.Errorf("unexpected line %q", got)
		}
	})
}

func TestHumanLeft(t *testing.T) {
	cases := map[time.Duration]string{
		20 * time.Second:             "21 s",
		90 * time.Second:             "2 min",
		119 * time.Minute:            "120 min",
		3*time.Hour + 30*time.Minute: "3.5 h",
	}
	for d, want := range cases {
		if got := humanLeft(d); got != want {
			t.Errorf("humanLeft(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestSpoolRoomLine(t *testing.T) {
	const gib = int64(1 << 30)
	const mb = int64(1 << 20)
	t.Run("plenty of room: says how far the dump may read ahead, as information", func(t *testing.T) {
		line, warn := spoolRoomLine("/dump-spool", uint64(100*gib), true, 8*gib, 512*mb)
		if warn || !strings.Contains(line, "100.0 GiB free in /dump-spool") || !strings.Contains(line, "up to 8.0 GiB") {
			t.Errorf("unexpected: warn=%v %q", warn, line)
		}
	})
	t.Run("the free space minus the margin bounds the read-ahead", func(t *testing.T) {
		line, warn := spoolRoomLine("/s", uint64(2*gib), true, 8*gib, 512*mb)
		if warn || !strings.Contains(line, "up to 1.5 GiB") {
			t.Errorf("unexpected: warn=%v %q", warn, line)
		}
	})
	t.Run("a nearly full disk is a warning that still says the copy is complete", func(t *testing.T) {
		line, warn := spoolRoomLine("/s", uint64(600*mb), true, 8*gib, 512*mb)
		if !warn || !strings.Contains(line, "only 0.6 GiB free") || !strings.Contains(line, "still complete") {
			t.Errorf("unexpected: warn=%v %q", warn, line)
		}
	})
	t.Run("an unreadable disk is a warning, not a failure", func(t *testing.T) {
		line, warn := spoolRoomLine("/s", 0, false, 8*gib, 512*mb)
		if !warn || !strings.Contains(line, "could not be read") {
			t.Errorf("unexpected: warn=%v %q", warn, line)
		}
	})
}
