package drains

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestCheckEgressIPPolicies(t *testing.T) {
	alwaysDenied := []string{
		"169.254.169.254", "169.254.0.1", "fe80::1", "fd00:ec2::254", "0.0.0.0", "::",
		"::ffff:169.254.169.254", // v4-mapped metadata
		"::ffff:0.0.0.0",
		"224.0.0.1", "ff02::1",
		"64:ff9b::a9fe:a9fe", // NAT64-embedded 169.254.169.254
	}
	private := []string{"127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "100.127.255.255", "fc00::1", "fd12:3456::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"}
	public := []string{"8.8.8.8", "1.1.1.1", "2606:4700::1111", "100.63.255.255", "172.32.0.1"}
	for _, policy := range []string{egressPublic, egressAny, ""} {
		for _, s := range alwaysDenied {
			if err := checkEgressIP(policy, netip.MustParseAddr(s)); !errors.Is(err, errEgressDenied) {
				t.Errorf("policy %q must always deny %s", policy, s)
			}
		}
		for _, s := range public {
			if err := checkEgressIP(policy, netip.MustParseAddr(s)); err != nil {
				t.Errorf("policy %q must allow public %s: %v", policy, s, err)
			}
		}
	}
	for _, s := range private {
		if err := checkEgressIP(egressPublic, netip.MustParseAddr(s)); !errors.Is(err, errEgressDenied) {
			t.Errorf("public policy must deny %s", s)
		}
		if err := checkEgressIP("", netip.MustParseAddr(s)); !errors.Is(err, errEgressDenied) {
			t.Errorf("an empty/unknown policy fails closed and must deny %s", s)
		}
		if err := checkEgressIP(egressAny, netip.MustParseAddr(s)); err != nil {
			t.Errorf("any policy must allow %s: %v", s, err)
		}
	}
}

func listenLoopback(t *testing.T) (net.Listener, string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l, l.Addr().String()
}

func TestGuardedDialerBlocksResolvedAddress(t *testing.T) {
	_, addr := listenLoopback(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// public: a literal loopback is blocked...
	if _, err := guardedDialer(egressPublic).DialContext(ctx, "tcp", addr); !errors.Is(err, errEgressDenied) {
		t.Fatalf("public policy must block loopback, got %v", err)
	}
	// ...and so is a NAME that resolves to loopback: the check runs on the RESOLVED ip (anti DNS-rebinding)
	_, port, _ := net.SplitHostPort(addr)
	if _, err := guardedDialer(egressPublic).DialContext(ctx, "tcp", "localhost:"+port); !errors.Is(err, errEgressDenied) {
		t.Fatalf("a name resolving to a denied address must be blocked after resolution, got %v", err)
	}
	// any: loopback is allowed
	c, err := guardedDialer(egressAny).DialContext(ctx, "tcp", addr)
	if err != nil {
		t.Fatalf("any policy must allow loopback: %v", err)
	}
	c.Close()
	// metadata is blocked under EVERY policy (nothing listens there: the block happens before any connect)
	for _, p := range []string{egressPublic, egressAny} {
		if _, err := guardedDialer(p).DialContext(ctx, "tcp", "169.254.169.254:80"); !errors.Is(err, errEgressDenied) {
			t.Fatalf("policy %q must block metadata, got %v", p, err)
		}
	}
	// UDP goes through the same hook
	if _, err := guardedDialer(egressAny).DialContext(ctx, "udp", "169.254.169.254:514"); !errors.Is(err, errEgressDenied) {
		t.Fatalf("udp to metadata must be blocked, got %v", err)
	}
}

func TestGuardedTransportBlocksRedirectToMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer srv.Close()
	client := &http.Client{Timeout: 5 * time.Second, Transport: guardedTransport(egressAny)} // loopback allowed, metadata never
	_, err := client.Get(srv.URL)
	if err == nil || !errors.Is(err, errEgressDenied) {
		t.Fatalf("a redirect to the metadata address must be blocked, got %v", err)
	}
	if de := classifyErr(err); de.class != errPolicy || !de.permanent {
		t.Fatalf("policy block must classify as permanent %q, got %+v", errPolicy, de)
	}
	if strings.Contains(classifyErr(err).Error(), "169.254") {
		t.Fatal("error text must not carry the address")
	}
}

func TestHTTPSenderEgressPolicy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	// public (the app-scope default) must refuse the loopback test server...
	s, err := newHTTPSender(protoCfg(srv.URL, egressPublic), "srv")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Send(context.Background(), batchOf("x")); classifyErr(err) == nil || classifyErr(err).class != errPolicy {
		t.Fatalf("public egress must block loopback, got %v", err)
	}
	// ...and `any` reaches it
	s2, _ := newHTTPSender(protoCfg(srv.URL, egressAny), "srv")
	if err := s2.Send(context.Background(), batchOf("x")); err != nil {
		t.Fatalf("any egress must reach loopback: %v", err)
	}
	// a non-http scheme is invalid
	if _, err := newHTTPSender(protoCfg("ftp://h/x", egressPublic), "srv"); err == nil {
		t.Fatal("ftp endpoint must be rejected")
	}
}
