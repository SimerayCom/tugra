package dockerstats

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Why this file exists: `docker stats` prints the cumulative network / block counters rounded to THREE
// significant digits ("1.23GB"). A container at 1.23 GB total therefore only changes its printed value every
// ~5 MB, so a 15 s delta of the printed numbers is 0 for any container moving less than ~330 kB/s — the
// dashboard showed "0 B/s" for almost everything. The Engine API returns the exact byte counters, so the rate
// is computed from those instead. Best effort: when the socket is unreachable the collector falls back to
// the (coarse) CLI numbers, exactly as before.

const (
	engineCallTimeout = 4 * time.Second
	engineWorkers     = 8
)

// exactIO is one container's exact cumulative counters (bytes) read from the Engine API.
type exactIO struct {
	netRx, netTx, blkRead, blkWrite float64
}

// ioSource fetches exact counters for a container id; ok=false means "use the CLI numbers instead".
type ioSource interface {
	IO(ctx context.Context, id string) (exactIO, bool)
}

// engineClient talks HTTP over the Docker unix socket (stdlib only).
type engineClient struct {
	hc *http.Client
}

// engineSocket resolves the Docker socket path: DOCKER_HOST=unix://… wins, else the default path.
// Returns "" when DOCKER_HOST points at a non-unix endpoint (tcp/ssh), which we do not speak.
func engineSocket(dockerHost string) string {
	if dockerHost == "" {
		return "/var/run/docker.sock"
	}
	if strings.HasPrefix(dockerHost, "unix://") {
		return strings.TrimPrefix(dockerHost, "unix://")
	}
	return ""
}

// newEngineClient returns nil when there is no usable unix socket.
func newEngineClient() *engineClient {
	sock := engineSocket(os.Getenv("DOCKER_HOST"))
	if sock == "" {
		return nil
	}
	if st, err := os.Stat(sock); err != nil || st.Mode()&os.ModeSocket == 0 {
		return nil
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
		MaxIdleConns:    engineWorkers,
		IdleConnTimeout: 30 * time.Second,
	}
	return &engineClient{hc: &http.Client{Transport: tr}}
}

type engineStats struct {
	Networks map[string]struct {
		RxBytes float64 `json:"rx_bytes"`
		TxBytes float64 `json:"tx_bytes"`
	} `json:"networks"`
	Blkio struct {
		IOServiceBytes []struct {
			Op    string  `json:"op"`
			Value float64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
}

// parseEngineStats sums a one-shot stats payload into exact counters. Network = every interface of the
// container; block = the recursive read/write byte totals (op names are case-insensitive: cgroup v1 reports
// "Read"/"Write", v2 "read"/"write").
func parseEngineStats(body []byte) (exactIO, error) {
	var s engineStats
	if err := json.Unmarshal(body, &s); err != nil {
		return exactIO{}, err
	}
	var out exactIO
	for _, n := range s.Networks {
		out.netRx += n.RxBytes
		out.netTx += n.TxBytes
	}
	for _, e := range s.Blkio.IOServiceBytes {
		switch strings.ToLower(e.Op) {
		case "read":
			out.blkRead += e.Value
		case "write":
			out.blkWrite += e.Value
		}
	}
	return out, nil
}

// IO implements ioSource.
func (c *engineClient) IO(ctx context.Context, id string) (exactIO, bool) {
	cctx, cancel := context.WithTimeout(ctx, engineCallTimeout)
	defer cancel()
	u := "http://docker/containers/" + url.PathEscape(id) + "/stats?stream=false&one-shot=true"
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, u, nil)
	if err != nil {
		return exactIO{}, false
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return exactIO{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return exactIO{}, false
	}
	var raw json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return exactIO{}, false
	}
	io, err := parseEngineStats(raw)
	if err != nil {
		return exactIO{}, false
	}
	return io, true
}

// fetchExact reads exact counters for every id with a small worker pool. Missing ids (an error, a container
// that vanished) are simply absent from the result.
func fetchExact(ctx context.Context, src ioSource, ids []string) map[string]exactIO {
	out := make(map[string]exactIO, len(ids))
	if src == nil || len(ids) == 0 {
		return out
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	jobs := make(chan string)
	workers := engineWorkers
	if len(ids) < workers {
		workers = len(ids)
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range jobs {
				if v, ok := src.IO(ctx, id); ok {
					mu.Lock()
					out[id] = v
					mu.Unlock()
				}
			}
		}()
	}
	for _, id := range ids {
		jobs <- id
	}
	close(jobs)
	wg.Wait()
	return out
}
