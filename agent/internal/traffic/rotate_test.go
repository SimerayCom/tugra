package traffic

import (
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readGz(t *testing.T, p string) string {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRotateOnlyWhenLargeAndFullyRead(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	tl := newTailer(p)
	appendFile(t, p, strings.Repeat("a", 99)+"\n")
	// under the limit: nothing happens
	tl.forEachLine(func([]byte) {})
	if ok, err := tl.rotateIfLarge(1000, 3); ok || err != nil {
		t.Fatalf("small log rotated: %v %v", ok, err)
	}
	// over the limit but unread bytes remain: the log is NOT cut
	appendFile(t, p, strings.Repeat("b", 1999)+"\n")
	if ok, _ := tl.rotateIfLarge(1000, 3); ok {
		t.Fatal("rotated with unread bytes")
	}
	if st, _ := os.Stat(p); st.Size() != 100+2000 {
		t.Fatalf("log was cut: %d", st.Size())
	}
	// read everything: now it rotates, the copy holds exactly what was there, the live file is empty and 0600 for the copy
	tl.forEachLine(func([]byte) {})
	ok, err := tl.rotateIfLarge(1000, 3)
	if !ok || err != nil {
		t.Fatalf("not rotated: %v %v", ok, err)
	}
	if st, _ := os.Stat(p); st.Size() != 0 {
		t.Fatalf("live log not truncated: %d", st.Size())
	}
	if got := readGz(t, p+".1.gz"); len(got) != 2100 {
		t.Fatalf("copy has %d bytes", len(got))
	}
	if st, _ := os.Stat(p + ".1.gz"); st.Mode().Perm() != 0o600 {
		t.Fatalf("copy mode %v", st.Mode().Perm())
	}
	// the tailer follows the truncated file from the top: new lines are read again
	appendFile(t, p, "x\n")
	var got []string
	tl.forEachLine(func(l []byte) { got = append(got, string(l)) })
	if len(got) != 1 || got[0] != "x" {
		t.Fatalf("after rotation read %v", got)
	}
}

func TestRotateKeepsAtMostKeepCopies(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	tl := newTailer(p)
	for i := 0; i < 5; i++ {
		appendFile(t, p, strings.Repeat(string(rune('a'+i)), 2000)+"\n")
		tl.forEachLine(func([]byte) {})
		if ok, err := tl.rotateIfLarge(1000, 3); !ok || err != nil {
			t.Fatalf("round %d: %v %v", i, ok, err)
		}
	}
	for n, want := range map[int]byte{1: 'e', 2: 'd', 3: 'c'} {
		if got := readGz(t, p+"."+string(rune('0'+n))+".gz"); got[0] != want {
			t.Fatalf("copy %d starts %q, want %q", n, got[0], want)
		}
	}
	if _, err := os.Stat(p + ".4.gz"); !os.IsNotExist(err) {
		t.Fatal("a fourth copy was kept")
	}
}
