package dockerstats

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	labelsTimeout  = 10 * time.Second
	maxLabelLen    = 120
	labelSeparator = "\t"
)

// labelFormat asks `docker ps` for the container name plus ONLY these allow-listed labels, in a fixed order
// (see parseLabels). Listing the labels explicitly (instead of dumping all of them) means a secret that some
// stack stuffed into a label can never reach the wire.
var labelFormat = strings.Join([]string{
	"{{.Names}}",
	`{{.Label "coolify.name"}}`,
	`{{.Label "coolify.resourceName"}}`,
	`{{.Label "coolify.projectName"}}`,
	`{{.Label "coolify.environmentName"}}`,
	`{{.Label "com.docker.compose.service"}}`,
}, labelSeparator)

// collectLabels returns the allow-listed labels per container NAME. Best effort: any failure yields nil and
// the hub just keeps its own name resolution.
func collectLabels(ctx context.Context) map[string]*protocol.ContainerMeta {
	cctx, cancel := context.WithTimeout(ctx, labelsTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, "docker", "ps", "--no-trunc", "--format", labelFormat).Output()
	if err != nil {
		return nil
	}
	return parseLabels(out)
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > maxLabelLen {
		s = s[:maxLabelLen]
	}
	return s
}

// parseLabels parses `docker ps --format labelFormat` output. A container with none of the labels is omitted.
func parseLabels(out []byte) map[string]*protocol.ContainerMeta {
	res := map[string]*protocol.ContainerMeta{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, labelSeparator)
		if len(f) < 6 || strings.TrimSpace(f[0]) == "" {
			continue
		}
		m := &protocol.ContainerMeta{Name: clip(f[1]), Resource: clip(f[2]), Project: clip(f[3]), Env: clip(f[4]), Service: clip(f[5])}
		if *m == (protocol.ContainerMeta{}) {
			continue
		}
		res[strings.TrimSpace(f[0])] = m
	}
	return res
}
