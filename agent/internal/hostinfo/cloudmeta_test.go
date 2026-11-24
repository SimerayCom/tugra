package hostinfo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicIP(t *testing.T) {
	cases := []struct {
		in    string
		want6 bool
		out   string
	}{
		{"203.0.113.7", false, "203.0.113.7"},
		{" 203.0.113.7\n", false, "203.0.113.7"},
		{"10.0.0.5", false, ""},
		{"192.168.1.5", false, ""},
		{"172.16.3.4", false, ""},
		{"100.85.1.2", false, ""},
		{"127.0.0.1", false, ""},
		{"169.254.169.254", false, ""},
		{"0.0.0.0", false, ""},
		{"not an ip", false, ""},
		{"<html>", false, ""},
		{"2001:db8::1", true, "2001:db8::1"},
		{"2001:db8::1", false, ""},
		{"203.0.113.7", true, ""},
		{"fe80::1", true, ""},
		{"fd00::1", true, ""},
	}
	for _, c := range cases {
		if got := publicIP(c.in, c.want6); got != c.out {
			t.Errorf("publicIP(%q,%v)=%q want %q", c.in, c.want6, got, c.out)
		}
	}
}

// fakeMeta serves one provider's metadata layout and 404s everything else.
func fakeMeta(t *testing.T, routes map[string]string, requireHeader map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for path, hdr := range requireHeader {
			if r.URL.Path == path && r.Header.Get(strings.SplitN(hdr, "=", 2)[0]) != strings.SplitN(hdr, "=", 2)[1] {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		if body, ok := routes[r.Method+" "+r.URL.Path]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		http.NotFound(w, r)
	}))
}

func TestDetectHetzner(t *testing.T) {
	srv := fakeMeta(t, map[string]string{"GET /hetzner/v1/metadata/public-ipv4": "203.0.113.7\n"}, nil)
	defer srv.Close()
	got := detectCloudIPs(context.Background(), srv.URL)
	if got.Provider != "hetzner" || got.IPv4 != "203.0.113.7" {
		t.Fatalf("got %+v", got)
	}
}

func TestDetectAWSNeedsIMDSv2Token(t *testing.T) {
	srv := fakeMeta(t, map[string]string{
		"PUT /latest/api/token":             "tok123",
		"GET /latest/meta-data/public-ipv4": "198.51.100.9",
		"GET /latest/meta-data/ipv6":        "2001:db8::9",
	}, map[string]string{"/latest/meta-data/public-ipv4": "X-aws-ec2-metadata-token=tok123"})
	defer srv.Close()
	got := detectCloudIPs(context.Background(), srv.URL)
	if got.Provider != "aws" || got.IPv4 != "198.51.100.9" {
		t.Fatalf("got %+v", got)
	}
}

func TestDetectGCPSendsFlavorHeader(t *testing.T) {
	srv := fakeMeta(t, map[string]string{
		"GET /computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip": "192.0.2.44",
	}, map[string]string{"/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip": "Metadata-Flavor=Google"})
	defer srv.Close()
	got := detectCloudIPs(context.Background(), srv.URL)
	if got.Provider != "gcp" || got.IPv4 != "192.0.2.44" {
		t.Fatalf("got %+v", got)
	}
}

func TestDetectDigitalOcean(t *testing.T) {
	srv := fakeMeta(t, map[string]string{
		"GET /metadata/v1/interfaces/public/0/ipv4/address": "203.0.113.20",
		"GET /metadata/v1/interfaces/public/0/ipv6/address": "2001:db8:1::20",
	}, nil)
	defer srv.Close()
	got := detectCloudIPs(context.Background(), srv.URL)
	if got.Provider != "digitalocean" || got.IPv4 != "203.0.113.20" || got.IPv6 != "2001:db8:1::20" {
		t.Fatalf("got %+v", got)
	}
}

func TestDetectVultrPicksThePublicInterface(t *testing.T) {
	srv := fakeMeta(t, map[string]string{"GET /v1.json": `{"interfaces":[
		{"network-type":"private","ipv4":{"address":"10.1.0.3"}},
		{"network-type":"public","ipv4":{"address":"203.0.113.31"},"ipv6":{"address":"2001:db8:2::31"}}]}`}, nil)
	defer srv.Close()
	got := detectCloudIPs(context.Background(), srv.URL)
	if got.Provider != "vultr" || got.IPv4 != "203.0.113.31" || got.IPv6 != "2001:db8:2::31" {
		t.Fatalf("got %+v", got)
	}
}

func TestDetectRejectsPrivateAndGarbageAnswers(t *testing.T) {
	srv := fakeMeta(t, map[string]string{
		"GET /hetzner/v1/metadata/public-ipv4":              "10.0.0.4",
		"GET /metadata/v1/interfaces/public/0/ipv4/address": "<html>captive portal</html>",
	}, nil)
	defer srv.Close()
	if got := detectCloudIPs(context.Background(), srv.URL); !got.Empty() {
		t.Fatalf("private/garbage answers must be ignored, got %+v", got)
	}
}

func TestDetectOffCloudIsEmpty(t *testing.T) {
	srv := fakeMeta(t, nil, nil)
	defer srv.Close()
	if got := detectCloudIPs(context.Background(), srv.URL); !got.Empty() {
		t.Fatalf("got %+v", got)
	}
}

func TestDetectDoesNotFollowRedirects(t *testing.T) {
	var hit bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true; _, _ = w.Write([]byte("203.0.113.99")) }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/x", http.StatusFound)
	}))
	defer srv.Close()
	if got := detectCloudIPs(context.Background(), srv.URL); !got.Empty() || hit {
		t.Fatalf("redirect was followed: %+v hit=%v", got, hit)
	}
}

func TestHostMetaArgs(t *testing.T) {
	args, err := HostMetaArgs("ghcr.io/example/agent:1.0.0")
	if err != nil || args[len(args)-1] != "hostmeta" || !strings.Contains(strings.Join(args, " "), "--network host") {
		t.Fatalf("args=%v err=%v", args, err)
	}
}
