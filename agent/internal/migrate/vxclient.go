package migrate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
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

// ---- streamed copy: begin / part / commit / finish / status ----------------------------------------------------

// VxFingerprint identifies the exact source state; the hub stores the begin-time one and compares the end-time one.
type VxFingerprint struct {
	ContainerID string `json:"containerId"`
	StartedAt   string `json:"startedAt"`
	FinishedAt  string `json:"finishedAt"`
	ExitCode    int    `json:"exitCode"`
	MountType   string `json:"mountType"`
	MountName   string `json:"mountName,omitempty"`
	ImageID     string `json:"imageId"`
	PgMajor     string `json:"pgMajor,omitempty"`
}

// VxBeginReq claims (or resumes) the transfer of one volume.
type VxBeginReq struct {
	RunID        string        `json:"runId"`
	PartRawBytes int           `json:"partRawBytes"`
	RawTotal     *int64        `json:"rawTotal,omitempty"`
	Fingerprint  VxFingerprint `json:"fingerprint"`
}

// VxManifestEntry is one part the hub already holds (raw descriptor; the compressed bytes live on the target).
type VxManifestEntry struct {
	Idx       int    `json:"idx"`
	RawOffset int64  `json:"rawOffset"`
	RawLen    int    `json:"rawLen"`
	RawSha256 string `json:"rawSha256"`
}

// VxBeginResp is the claim result. State "APPLYING" means a finish already ran: only poll status.
type VxBeginResp struct {
	TransferID     string            `json:"transferId"`
	Attempt        int               `json:"attempt"`
	State          string            `json:"state"`
	PartRawBytes   int               `json:"partRawBytes"`
	ResumeFromPart int               `json:"resumeFromPart"`
	Manifest       []VxManifestEntry `json:"manifest"`
	AlreadyDone    bool              `json:"alreadyDone"`
	DiskVerdict    *struct {
		OK      bool           `json:"ok"`
		Details map[string]any `json:"details"`
	} `json:"diskVerdict"`
	VxExpiry
}

// VxPartReq describes one part: its raw slice and its compressed member.
type VxPartReq struct {
	RunID     string `json:"runId"`
	RawOffset int64  `json:"rawOffset"`
	RawLen    int    `json:"rawLen"`
	RawSha256 string `json:"rawSha256"`
	Size      int    `json:"size"`
	Sha256    string `json:"sha256"`
}

// VxPartResp: the signed relay path to PUT to, or alreadyDone (committed), or busy (the relay pool is full: back off).
type VxPartResp struct {
	SrcPath     string `json:"srcPath"`
	AlreadyDone bool   `json:"alreadyDone"`
	Busy        bool   `json:"busy"`
	VxExpiry
}

// VxCommitResp: Done, or Pending (ask again), or a retryable/non-retryable failure with a scrubbed reason.
type VxCommitResp struct {
	Done      bool   `json:"done"`
	Pending   bool   `json:"pending"`
	Retryable bool   `json:"retryable"`
	Reason    string `json:"reason"`
	PartsDone int    `json:"partsDone"`
	BytesDone int64  `json:"bytesDone"`
	VxExpiry
}

type vxRunReq struct {
	RunID string `json:"runId"`
	Phase string `json:"phase,omitempty"`
}

// VxFinishReq closes the copy: the totals the hub cross-checks and the source state AFTER the last byte.
type VxFinishReq struct {
	RunID            string      `json:"runId"`
	Parts            int         `json:"parts"`
	RawBytes         int64       `json:"rawBytes"`
	Entries          int64       `json:"entries"`
	FingerprintAfter VxAfterFing `json:"fingerprintAfter"`
}

// VxAfterFing is the end-of-copy source state (it must equal the begin one and not be running).
type VxAfterFing struct {
	ContainerID string `json:"containerId"`
	StartedAt   string `json:"startedAt"`
	FinishedAt  string `json:"finishedAt"`
	Running     bool   `json:"running"`
}

// VxStatusResp is what the migrator polls after finish.
type VxStatusResp struct {
	State        string `json:"state"`
	Phase        string `json:"phase"`
	PartsDone    int    `json:"partsDone"`
	BytesDone    int64  `json:"bytesDone"`
	RawBytesDone int64  `json:"rawBytesDone"`
	Error        string `json:"error"`
	Steps        []struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"steps"`
	VxExpiry
}

// noteExpiry records the renewed token expiry a vx response carried (margins compare against the LATEST value).
func (h *Hub) noteExpiry(e VxExpiry) {
	if t := e.time(); !t.IsZero() {
		h.expMu.Lock()
		h.expiry = t
		h.expMu.Unlock()
	}
}

// Expiry is the latest renewed token expiry (zero until a vx call returned one).
func (h *Hub) Expiry() time.Time {
	h.expMu.Lock()
	defer h.expMu.Unlock()
	return h.expiry
}

// SetOutageWait sets how long vx calls wait out a restarting hub (default 0 = no waiting).
func (h *Hub) SetOutageWait(d time.Duration) { h.outage = d }

// outageOpen reports whether the outage window that started at *until's first use is still open.
func (h *Hub) outageOpen(until *time.Time) bool {
	if h.outage <= 0 {
		return false
	}
	if until.IsZero() {
		*until = httpNow().Add(h.outage)
	}
	return httpNow().Before(*until)
}

func (h *Hub) vxPath(itemRef, tail string) string {
	return vxPrefix + url.PathEscape(itemRef) + "/" + tail
}

// VxBegin claims the volume's transfer (or resumes it) and returns the manifest of what the hub already holds.
func (h *Hub) VxBegin(ctx context.Context, itemRef string, req VxBeginReq) (*VxBeginResp, error) {
	var r VxBeginResp
	if err := h.doBody(ctx, http.MethodPost, h.vxPath(itemRef, "begin"), req, &r, 4, h.outage); err != nil {
		return nil, err
	}
	h.noteExpiry(r.VxExpiry)
	return &r, nil
}

// VxRegisterPart registers one part. {busy:true} (the hub's relay pool is full) is an UNCOUNTED, jittered 1..15 s wait.
func (h *Hub) VxRegisterPart(ctx context.Context, itemRef string, idx int, req VxPartReq) (*VxPartResp, error) {
	deadline := httpNow().Add(45 * time.Minute) // a pool that never frees is a stuck hub, not a part problem
	for {
		var r VxPartResp
		if err := h.doBody(ctx, http.MethodPost, h.vxPath(itemRef, "parts/"+strconv.Itoa(idx)), req, &r, 3, 0); err != nil {
			return nil, err
		}
		h.noteExpiry(r.VxExpiry)
		if !r.Busy {
			return &r, nil
		}
		if !httpNow().Before(deadline) {
			return nil, &HubError{Status: 503, Kind: KindServer, Msg: "the hub's relay stayed busy"}
		}
		wait := time.Second + time.Duration(httpNow().UnixNano()%14_000)*time.Millisecond
		if err := waitRetry(ctx, wait); err != nil {
			return nil, err
		}
	}
}

// relayPathRe is the ONLY path shape a PUT may target (what the hub's mintRelayPath produces).
var relayPathRe = regexp.MustCompile(`^/api/v1/agent-vx/t/[A-Za-z0-9_-]{16,64}\?exp=[0-9]{1,12}&sig=[A-Za-z0-9_-]{16,128}$`)

// VxPutPart PUTs one member to the signed relay path: exact Content-Length (no chunked encoding), no redirects, the
// request goes to the configured hub origin only, no overall timeout (a slow link may take minutes; the hub's relay has
// its own idle limit) and the migration token is NOT sent (the HMAC in the URL is the whole credential).
func (h *Hub) VxPutPart(ctx context.Context, srcPath string, buf []byte) error {
	if !relayPathRe.MatchString(srcPath) {
		return fmt.Errorf("the hub returned an unexpected relay path")
	}
	u := *h.base
	rel, err := url.Parse(srcPath)
	if err != nil {
		return fmt.Errorf("the hub returned an unexpected relay path")
	}
	u.Path = strings.TrimRight(h.base.Path, "/") + rel.Path
	u.RawQuery = rel.RawQuery
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), bytes.NewReader(buf))
	if err != nil {
		return err
	}
	if req.URL.Scheme != h.base.Scheme || req.URL.Host != h.base.Host {
		return fmt.Errorf("refusing to send to a different origin")
	}
	req.ContentLength = int64(len(buf))
	req.TransferEncoding = nil
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("User-Agent", h.ua)
	req.Header.Set("Expect", "")
	resp, err := h.hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &HubError{Kind: KindServer, Msg: scrubNetErr(err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return &HubError{Status: resp.StatusCode, Kind: KindRedirect, Msg: "the hub returned a redirect on a part upload; refusing to follow"}
	}
	return classify(resp.StatusCode, readErrMessage(resp.Body))
}

// VxCommit waits for the target to confirm part idx (the hub long-polls; {pending:true} means ask again).
func (h *Hub) VxCommit(ctx context.Context, itemRef string, idx int, runID string) (*VxCommitResp, error) {
	deadline := httpNow().Add(30 * time.Minute)
	for {
		var r VxCommitResp
		if err := h.doBody(ctx, http.MethodPost, h.vxPath(itemRef, "parts/"+strconv.Itoa(idx)+"/commit"), vxRunReq{RunID: runID}, &r, 3, 0); err != nil {
			return nil, err
		}
		h.noteExpiry(r.VxExpiry)
		if !r.Pending {
			return &r, nil
		}
		if !httpNow().Before(deadline) {
			return &VxCommitResp{Done: false, Retryable: true, Reason: "the target did not confirm the part in time"}, nil
		}
	}
}

// VxFinish closes the copy; the hub validates, re-checks the destination and starts the apply (202).
func (h *Hub) VxFinish(ctx context.Context, itemRef string, req VxFinishReq) error {
	var r VxExpiry
	if err := h.doBody(ctx, http.MethodPost, h.vxPath(itemRef, "finish"), req, &r, 4, h.outage); err != nil {
		return err
	}
	h.noteExpiry(r)
	return nil
}

// VxStatus polls the transfer (also renews the token expiry).
func (h *Hub) VxStatus(ctx context.Context, itemRef string) (*VxStatusResp, error) {
	var r VxStatusResp
	if err := h.doJSON(ctx, http.MethodGet, h.vxPath(itemRef, "status"), nil, &r, false, 5); err != nil {
		return nil, err
	}
	h.noteExpiry(r.VxExpiry)
	return &r, nil
}

// VxBeat renews the lease and the token during phases that make no other call.
func (h *Hub) VxBeat(ctx context.Context, itemRef, runID, phase string) error {
	var r VxExpiry
	if err := h.doBody(ctx, http.MethodPost, h.vxPath(itemRef, "beat"), vxRunReq{RunID: runID, Phase: phase}, &r, 2, 0); err != nil {
		return err
	}
	h.noteExpiry(r)
	return nil
}

// VxReset discards the volume's staged parts and starts over (only on the owner's explicit --reset-volume).
func (h *Hub) VxReset(ctx context.Context, itemRef, runID string) error {
	return h.doBody(ctx, http.MethodPost, h.vxPath(itemRef, "reset"), vxRunReq{RunID: runID}, nil, 3, 0)
}

// VxAbort releases the lease after an interruption, keeping the staged parts (best effort).
func (h *Hub) VxAbort(ctx context.Context, itemRef, runID string) error {
	return h.doBody(ctx, http.MethodPost, h.vxPath(itemRef, "abort"), vxRunReq{RunID: runID}, nil, 2, 0)
}
