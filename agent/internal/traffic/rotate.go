package traffic

import (
	"compress/gzip"
	"fmt"
	"io"
	"os"
)

const (
	// accessLogMaxBytes is the size at which the agent rotates the proxy's access log. Traefik never rotates its own
	// access log and the agent's own filesystem has no logrotate (nor does it see the host's /etc/logrotate.d), so the
	// size bound lives here, next to the only reader of the file.
	accessLogMaxBytes = 50 << 20
	// accessLogKeep is how many rotated, compressed copies are kept (access.json.1.gz ... access.json.N.gz).
	accessLogKeep = 3
)

// rotateIfLarge rotates the log (copytruncate, as Traefik keeps appending to the same open file) once it is larger than
// maxBytes AND every byte of it has been read: nothing unread is ever cut off. The copies are gzip, mode 0600 (the file holds
// client addresses), the oldest falls off. A failure leaves the log as it is and is retried at the next pass.
func (t *tailer) rotateIfLarge(maxBytes int64, keep int) (bool, error) {
	st, err := os.Stat(t.path)
	if err != nil || st.IsDir() || st.Size() <= maxBytes {
		return false, nil
	}
	if !os.SameFile(t.info, st) || t.offset < st.Size() {
		return false, nil // unread bytes (or a file we have not followed yet): rotate after they are read
	}
	return true, rotateLog(t.path, st.Size(), keep)
}

func rotateLog(path string, size int64, keep int) error {
	// shift .N-1 -> .N (the oldest is replaced), then the live file becomes .1
	for i := keep - 1; i >= 1; i-- {
		from, to := fmt.Sprintf("%s.%d.gz", path, i), fmt.Sprintf("%s.%d.gz", path, i+1)
		if err := os.Rename(from, to); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp := path + ".1.gz.tmp"
	dst, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	zw := gzip.NewWriter(dst)
	// copy exactly the bytes that were seen: what Traefik appends meanwhile is lost by the truncate, like any copytruncate
	_, cerr := io.Copy(zw, io.NewSectionReader(src, 0, size))
	if cerr == nil {
		cerr = zw.Close()
	}
	if cerr == nil {
		cerr = dst.Close()
	} else {
		_ = dst.Close()
	}
	if cerr != nil {
		_ = os.Remove(tmp)
		return cerr
	}
	if err := os.Rename(tmp, path+".1.gz"); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Truncate(path, 0)
}
