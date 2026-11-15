package drains

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/url"
	"strconv"
	"syscall"
)

// Error classes reported to the hub (mirrors DrainErrClass in packages/shared). Only the class ever leaves the
// agent: never raw error text, an endpoint or a token.
const (
	errDNS      = "dns"
	errDial     = "dial"
	errTLS      = "tls"
	errTimeout  = "timeout"
	errRefused  = "refused"
	errHTTP     = "http"
	errWrite    = "write"
	errAck      = "ack"
	errPolicy   = "policy"
	errConfig   = "config"
	errAuth     = "auth" // the sink requires user authentication, which a shared-key drain cannot do
	errOverflow = "overflow"
)

// drainErr is a delivery failure with its class. permanent errors (bad TLS trust, bad config, policy) are not
// retried. Error() deliberately carries only the class so a log line can never leak an endpoint.
type drainErr struct {
	class     string
	permanent bool
	err       error
}

func (e *drainErr) Error() string { return "drain error: " + e.class }
func (e *drainErr) Unwrap() error { return e.err }

func newDrainErr(class string, permanent bool, err error) *drainErr {
	return &drainErr{class: class, permanent: permanent, err: err}
}

// httpStatusErr is a non-2xx answer from an http/loki/datadog sink.
type httpStatusErr struct {
	endpoint string
	code     int
}

func (e *httpStatusErr) Error() string {
	return "drain " + e.endpoint + " returned HTTP " + strconv.Itoa(e.code)
}

// classifyErr maps any send error to a *drainErr with a class from the fixed enum.
func classifyErr(err error) *drainErr {
	if err == nil {
		return nil
	}
	var de *drainErr
	if errors.As(err, &de) {
		return de
	}
	var hs *httpStatusErr
	if errors.As(err, &hs) {
		return newDrainErr(errHTTP, !retriable(hs.code), err)
	}
	if errors.Is(err, errEgressDenied) {
		return newDrainErr(errPolicy, true, err)
	}
	var (
		unknownAuth x509.UnknownAuthorityError
		hostErr     x509.HostnameError
		certInvalid x509.CertificateInvalidError
		verifyErr   *tls.CertificateVerificationError
		recHdr      tls.RecordHeaderError
		alertErr    tls.AlertError
	)
	if errors.As(err, &unknownAuth) || errors.As(err, &hostErr) || errors.As(err, &certInvalid) ||
		errors.As(err, &verifyErr) || errors.As(err, &recHdr) || errors.As(err, &alertErr) {
		return newDrainErr(errTLS, true, err)
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return newDrainErr(errDNS, false, err)
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return newDrainErr(errRefused, false, err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return newDrainErr(errTimeout, false, err)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return newDrainErr(errTimeout, false, err)
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return newDrainErr(errDial, false, err)
	}
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Op == "dial" {
		return newDrainErr(errDial, false, err)
	}
	return newDrainErr(errWrite, false, err)
}
