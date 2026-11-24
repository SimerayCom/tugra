package hostinfo

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Cloud metadata public-IP detection. Every probe talks ONLY to the link-local metadata address that cloud
// providers expose on the instance itself (169.254.169.254): the request never leaves the machine, so it is not an
// outbound IP-lookup service. A host that is not a cloud instance simply gets no answer and reports nothing.

// metadataBase is the link-local metadata endpoint (overridable in tests).
const metadataBase = "http://169.254.169.254"

// metadataTimeout bounds the whole detection run. Probes run in parallel, so a blackholed address costs this once.
const metadataTimeout = 3 * time.Second

// CloudIPs is what the provider's metadata service says the instance's public addresses are.
type CloudIPs struct {
	Provider string `json:"provider,omitempty"`
	IPv4     string `json:"ipv4,omitempty"`
	IPv6     string `json:"ipv6,omitempty"`
}

// Empty reports whether nothing usable was found.
func (c CloudIPs) Empty() bool { return c.IPv4 == "" && c.IPv6 == "" }

// publicIP returns the canonical form of s when it parses as a globally-routable unicast address, else "".
// Provider replies are untrusted text: anything that is not a plain public IP literal is dropped.
func publicIP(s string, want6 bool) string {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return ""
	}
	if (ip.To4() == nil) != want6 {
		return ""
	}
	// CGNAT 100.64.0.0/10 is shared address space, never a public instance address.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1]&0xc0 == 64 {
		return ""
	}
	return ip.String()
}

type metaProbe struct {
	provider string
	run      func(ctx context.Context, c *http.Client, base string) CloudIPs
}

// metaGet performs one bounded GET/PUT against the metadata service and returns the body (max 8 KiB) on a 200.
func metaGet(ctx context.Context, c *http.Client, method, url string, headers map[string]string) (string, bool) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return "", false
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}

var metaProbes = []metaProbe{
	{"hetzner", func(ctx context.Context, c *http.Client, base string) CloudIPs {
		body, ok := metaGet(ctx, c, http.MethodGet, base+"/hetzner/v1/metadata/public-ipv4", nil)
		if !ok {
			return CloudIPs{}
		}
		return CloudIPs{IPv4: publicIP(body, false)}
	}},
	{"aws", func(ctx context.Context, c *http.Client, base string) CloudIPs {
		// IMDSv2: a session token first (IMDSv1 may be disabled), then the address.
		token, ok := metaGet(ctx, c, http.MethodPut, base+"/latest/api/token", map[string]string{"X-aws-ec2-metadata-token-ttl-seconds": "60"})
		if !ok || token == "" {
			return CloudIPs{}
		}
		h := map[string]string{"X-aws-ec2-metadata-token": token}
		var out CloudIPs
		if body, ok := metaGet(ctx, c, http.MethodGet, base+"/latest/meta-data/public-ipv4", h); ok {
			out.IPv4 = publicIP(body, false)
		}
		if body, ok := metaGet(ctx, c, http.MethodGet, base+"/latest/meta-data/ipv6", h); ok {
			out.IPv6 = publicIP(body, true)
		}
		return out
	}},
	{"gcp", func(ctx context.Context, c *http.Client, base string) CloudIPs {
		body, ok := metaGet(ctx, c, http.MethodGet, base+"/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip", map[string]string{"Metadata-Flavor": "Google"})
		if !ok {
			return CloudIPs{}
		}
		return CloudIPs{IPv4: publicIP(body, false)}
	}},
	{"digitalocean", func(ctx context.Context, c *http.Client, base string) CloudIPs {
		var out CloudIPs
		if body, ok := metaGet(ctx, c, http.MethodGet, base+"/metadata/v1/interfaces/public/0/ipv4/address", nil); ok {
			out.IPv4 = publicIP(body, false)
		}
		if out.IPv4 == "" {
			return CloudIPs{}
		}
		if body, ok := metaGet(ctx, c, http.MethodGet, base+"/metadata/v1/interfaces/public/0/ipv6/address", nil); ok {
			out.IPv6 = publicIP(body, true)
		}
		return out
	}},
	{"vultr", func(ctx context.Context, c *http.Client, base string) CloudIPs {
		body, ok := metaGet(ctx, c, http.MethodGet, base+"/v1.json", nil)
		if !ok {
			return CloudIPs{}
		}
		var doc struct {
			Interfaces []struct {
				NetworkType string `json:"network-type"`
				IPv4        struct {
					Address string `json:"address"`
				} `json:"ipv4"`
				IPv6 struct {
					Address string `json:"address"`
				} `json:"ipv6"`
			} `json:"interfaces"`
		}
		if json.Unmarshal([]byte(body), &doc) != nil {
			return CloudIPs{}
		}
		for _, i := range doc.Interfaces {
			if i.NetworkType != "public" {
				continue
			}
			return CloudIPs{IPv4: publicIP(i.IPv4.Address, false), IPv6: publicIP(i.IPv6.Address, true)}
		}
		return CloudIPs{}
	}},
}

// DetectCloudIPs asks the instance's own cloud metadata service (Hetzner, AWS IMDSv2, GCP, DigitalOcean, Vultr) for
// its public addresses. Best-effort and bounded by metadataTimeout; the first provider that answers with a usable
// address wins (providers are tried in parallel, ties resolved in list order). Oracle Cloud is intentionally absent:
// its metadata service does not expose the instance's public IP.
func DetectCloudIPs(ctx context.Context) CloudIPs { return detectCloudIPs(ctx, metadataBase) }

func detectCloudIPs(ctx context.Context, base string) CloudIPs {
	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()
	// No proxy, no redirects: this must only ever reach the link-local address it was pointed at.
	client := &http.Client{
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	results := make([]CloudIPs, len(metaProbes))
	var wg sync.WaitGroup
	for i, p := range metaProbes {
		wg.Add(1)
		go func(i int, p metaProbe) {
			defer wg.Done()
			r := p.run(ctx, client, base)
			if !r.Empty() {
				r.Provider = p.provider
				results[i] = r
			}
		}(i, p)
	}
	wg.Wait()
	for _, r := range results {
		if !r.Empty() {
			return r
		}
	}
	return CloudIPs{}
}

// PrintCloudIPs is the `hostmeta` subcommand: run on the host network (the IMDSv2 hop limit of 1 blocks a bridged
// container), it prints the detected CloudIPs as JSON and exits 0 even when nothing was found.
func PrintCloudIPs(w io.Writer) int {
	if err := json.NewEncoder(w).Encode(DetectCloudIPs(context.Background())); err != nil {
		return 1
	}
	return 0
}
