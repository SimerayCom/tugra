package metrics

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// The agent is a container on Docker's default bridge: its /proc/net/dev is its OWN network namespace (lo + eth0), so
// gopsutil would report the agent's heartbeat traffic as the server's throughput. When the agent runs from its image
// (TUGRA_AGENT_IMAGE is set) the host's counters are read from a small long-lived helper of the agent's own image on
// the host network: `docker exec tugra-netdev cat /proc/net/dev`, a few ms, cached off the heartbeat path. A dev binary run
// directly on a host (no image env) already is the host: it keeps reading its own namespace.

const (
	netdevHelperName = "tugra-netdev"
	netdevRefresh    = 2 * time.Second
	netdevExecLimit  = 6 * time.Second
)

// hostNetEnabled: the agent is a container, so its own netns is not the server's.
var hostNetEnabled = func() bool { return strings.TrimSpace(os.Getenv("TUGRA_AGENT_IMAGE")) != "" }

// hostNetFetch returns the host's cumulative rx/tx bytes over the real (non-virtual) interfaces.
var hostNetFetch = fetchHostNet

func fetchHostNet() (rx, tx uint64, err error) {
	img := strings.TrimSpace(os.Getenv("TUGRA_AGENT_IMAGE"))
	if img == "" {
		return 0, 0, errors.New("no agent image")
	}
	ctx, cancel := context.WithTimeout(context.Background(), netdevExecLimit)
	defer cancel()
	if err := ensureNetdevHelper(ctx, img); err != nil {
		return 0, 0, err
	}
	out, err := exec.CommandContext(ctx, "docker", "exec", netdevHelperName, "cat", "/proc/net/dev").Output()
	if err != nil {
		return 0, 0, err
	}
	return parseNetDev(string(out))
}

// ensureNetdevHelper makes sure a running helper of THIS agent image exists (a helper of an older image is replaced, so an
// old image is not pinned on the host). The helper does nothing but `sleep`: read-only, no capabilities, no socket.
func ensureNetdevHelper(ctx context.Context, img string) error {
	out, err := exec.CommandContext(ctx, "docker", "inspect", "-f", "{{.State.Running}}|{{.Config.Image}}", netdevHelperName).Output()
	if err == nil && strings.TrimSpace(string(out)) == "true|"+img {
		return nil
	}
	_ = exec.CommandContext(ctx, "docker", "rm", "-f", netdevHelperName).Run()
	return exec.CommandContext(ctx, "docker", "run", "-d", "--pull", "never", "--name", netdevHelperName,
		"--label", "tugra.role=netdev-helper", "--network", "host", "--read-only", "--cap-drop", "ALL",
		"--security-opt", "no-new-privileges", "--stop-timeout", "1", "--entrypoint", "sleep", img, "infinity").Run()
}

// parseNetDev sums rx/tx bytes of /proc/net/dev over the interfaces isVirtualNIC does not drop.
func parseNetDev(s string) (rx, tx uint64, err error) {
	sc := bufio.NewScanner(strings.NewReader(s))
	seen := false
	for sc.Scan() {
		line := sc.Text()
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue // the two header lines
		}
		name := strings.TrimSpace(line[:i])
		f := strings.Fields(line[i+1:])
		if len(f) < 9 {
			continue
		}
		seen = true
		if isVirtualNIC(name) {
			continue
		}
		r, e1 := strconv.ParseUint(f[0], 10, 64)
		t, e2 := strconv.ParseUint(f[8], 10, 64)
		if e1 != nil || e2 != nil {
			continue
		}
		rx += r
		tx += t
	}
	if !seen {
		return 0, 0, errors.New("no interfaces in /proc/net/dev")
	}
	return rx, tx, nil
}

// kickNet launches at most one background refresh of the host's cumulative network counters when the cache is older than
// netdevRefresh. It never blocks the heartbeat.
func (c *Collector) kickNet() {
	c.netMu.Lock()
	fresh := !c.netAt.IsZero() && time.Since(c.netAt) < netdevRefresh
	c.netMu.Unlock()
	if fresh || !c.netInflight.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer c.netInflight.Store(false)
		at := time.Now()
		rx, tx, err := hostNetFetch()
		c.netMu.Lock()
		defer c.netMu.Unlock()
		if err != nil {
			c.netOK = false
			c.netAt = at // retry on the normal cadence, not in a tight loop
			return
		}
		c.netRx, c.netTx, c.netOK, c.netAt, c.netCountersAt = rx, tx, true, at, at
	}()
}
