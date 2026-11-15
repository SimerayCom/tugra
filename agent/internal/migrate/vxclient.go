package migrate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"
)

// vxPrefix is the streamed-volume route family on the hub (token-authenticated like the rest).
const vxPrefix = "vx/"

// InvItem is one inventory entry (the hub validates it strictly: unknown keys are a 400).
type InvItem struct {
	ItemRef    string      `json:"itemRef"`
	Found      bool        `json:"found"`
	MountType  string      `json:"mountType"`
	RawBytes   int64       `json:"rawBytes"`
	Entries    int64       `json:"entries"`
	Specials   InvSpecials `json:"specials"`
	Running    bool        `json:"running"`
	ExitCode   *int        `json:"exitCode,omitempty"`
	FinishedAt string      `json:"finishedAt,omitempty"`
	Image      string      `json:"image,omitempty"`
	PgMajor    string      `json:"pgMajor,omitempty"`
	PgLayout   string      `json:"pgLayout,omitempty"`
	MountDest  string      `json:"mountDest,omitempty"`
	Reason     string      `json:"reason,omitempty"`
}

// InvSpecials counts the entries a tar cannot carry faithfully (sockets are skipped, fifos archived, devices refused).
type InvSpecials struct {
	Sockets int `json:"sockets"`
	Fifos   int `json:"fifos"`
	Devices int `json:"devices"`
}

type invReq struct {
	RunID string    `json:"runId"`
	Items []InvItem `json:"items"`
}

// VxExpiry is what every vx response carries: the renewed token expiry the migrator compares its margins against.
type VxExpiry struct {
	ExpiresAt string `json:"expiresAt"`
}

func (e VxExpiry) time() time.Time {
	t, _ := time.Parse(time.RFC3339, e.ExpiresAt)
	return t
}

type invResp struct {
	Stored int `json:"stored"`
	VxExpiry
}

// DiskResp is the hub's verdict on the target host's free space for a transfer (read-only probe of the TARGET).
type DiskResp struct {
	OK      bool           `json:"ok"`
	Unknown bool           `json:"unknown"`
	Details map[string]any `json:"details"`
}

type diskReq struct {
	RunID    string `json:"runId"`
	RawBytes *int64 `json:"rawBytes,omitempty"`
}

// doBody performs a control-plane POST with a JSON body, retry + classification. outage > 0 additionally keeps
// retrying (jittered 1..60 s) while the hub answers 404/502/503/504 or the connection fails, for up to that long: a hub
// restart is a pause, not a failure. attempts bounds the ordinary retries.
func (h *Hub) doBody(ctx context.Context, method, path string, body, out any, attempts int, outage time.Duration) error {
	var raw []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		raw = b
	}
	deadline := httpNow().Add(outage)
	backoff := time.Second
	var last error
	for i := 0; ; i++ {
		if i > 0 {
			if err := waitRetry(ctx, jitter(backoff)); err != nil {
				return err
			}
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
		var rdr io.Reader = http.NoBody
		if raw != nil {
			rdr = bytes.NewReader(raw)
		}
		req, err := h.newReq(ctx, method, h.url(path, nil), rdr)
		if err != nil {
			return err
		}
		if raw != nil {
			req.Header.Set("Content-Type", "application/json")
			req.ContentLength = int64(len(raw))
		} else if method == http.MethodPost {
			req.ContentLength = 0
		}
		resp, err := h.hc.Do(req)
		var herr error
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			herr = &HubError{Kind: KindServer, Msg: scrubNetErr(err)}
		} else {
			_, herr = h.handle(resp, out, false)
			if herr == nil {
				return nil
			}
			if ra := retryAfter(resp.Header); ra > 0 {
				backoff = ra
			}
		}
		last = herr
		var he *HubError
		if !errors.As(herr, &he) {
			return herr
		}
		transport := he.Kind == KindServer && he.Status == 0
		retriable := isRetriableStatus(he.Status) || transport
		// A control-plane 404 is a real answer ("no such target"), never an outage; only the relay PUT treats 404 as one.
		if outage > 0 && httpNow().Before(deadline) && (he.Status == 502 || he.Status == 503 || he.Status == 504 || transport) {
			continue // the hub is restarting / unreachable: wait it out
		}
		if retriable && i+1 < attempts {
			continue
		}
		return last
	}
}

// VxInventory posts the read-only inspection of the source volumes and returns the renewed token expiry.
func (h *Hub) VxInventory(ctx context.Context, runID string, items []InvItem) (time.Time, error) {
	var r invResp
	if err := h.doBody(ctx, http.MethodPost, vxPrefix+"inventory", invReq{RunID: runID, Items: items}, &r, 4, 0); err != nil {
		return time.Time{}, err
	}
	return r.time(), nil
}

// VxDiskCheck asks the hub whether the target can hold rawBytes of this volume (dry-run; nothing moves).
func (h *Hub) VxDiskCheck(ctx context.Context, itemRef, runID string, rawBytes *int64) (*DiskResp, error) {
	var r DiskResp
	if err := h.doBody(ctx, http.MethodPost, vxPrefix+url.PathEscape(itemRef)+"/disk-check", diskReq{RunID: runID, RawBytes: rawBytes}, &r, 3, 0); err != nil {
		return nil, err
	}
	return &r, nil
}
