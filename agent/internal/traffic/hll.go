package traffic

import (
	"encoding/base64"
	"math"
	"math/bits"
)

// HyperLogLog sketch for unique visitors. THE CONTRACT BELOW IS IMPLEMENTED IDENTICALLY IN TypeScript
// (apps/hub-api/src/traffic/hll.ts); both must produce byte-identical sketches for the same input list, which
// the golden tests on each side pin (same IP list, same expected base64).
//
//   - precision p = 12 -> m = 4096 registers, one byte each (value 0..53 in practice, 0..63 allowed).
//     The sketch is the 4096-byte register array; its base64 is the TrafficDomainStat.unique string.
//   - Input is the NORMALIZED client IP string (parseClientAddr -> Unmap -> drop zone -> String(); public addresses only,
//     private/loopback/link-local/invalid are never added), hashed to 64 bits in two fixed steps:
//     (1) FNV-1a-64 over the UTF-8 bytes (offset 0xcbf29ce484222325, prime 0x100000001b3);
//     (2) splitmix64 finalizer: z ^= z>>30; z *= 0xbf58476d1ce4e5b9; z ^= z>>27; z *= 0x94d049bb133111eb; z ^= z>>31.
//   - index = z >> (64-p) (top p bits); rank = min(leadingZeros64(z << p), 64-p) + 1 (an all-zero suffix has
//     rank 64-p+1); register[index] = max(register[index], rank).
//   - estimate: E = alpha_m*m*m / sum(2^-reg[j]), alpha_m = 0.7213/(1+1.079/m); if E <= 2.5*m and V (zero
//     registers) > 0 then E = m*ln(m/V). No large-range correction (64-bit hash). Rounded to a non-negative int.
//   - merge(a, b) = element-wise max.
//
// Privacy: the sketch holds only max leading-zero ranks. The address is hashed in memory and dropped; nothing
// derived from one address can be recovered from (or even attributed within) the registers, so unique
// visitors are counted in every IP mode, including "off".
const (
	hllP          = 12
	hllM          = 1 << hllP
	hllSuffixBits = 64 - hllP
)

// hll is one sketch. The zero value is not usable; use newHLL.
type hll struct{ reg [hllM]uint8 }

func newHLL() *hll { return &hll{} }

// hllHash is the contract's two-step 64-bit hash of an IP string.
func hllHash(s string) uint64 {
	h := uint64(0xcbf29ce484222325)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= 0x100000001b3
	}
	z := h
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// addString folds one already-normalized address string in.
func (s *hll) addString(ip string) {
	z := hllHash(ip)
	idx := z >> hllSuffixBits
	lz := bits.LeadingZeros64(z << hllP)
	if lz > hllSuffixBits {
		lz = hllSuffixBits
	}
	if r := uint8(lz + 1); r > s.reg[idx] {
		s.reg[idx] = r
	}
}

// addClient parses and normalizes a raw client address (same parsing as the geo/network lookups) and adds it
// when it is a public address. Reports whether it was added. The raw value is not retained.
func (s *hll) addClient(clientHost string) bool {
	addr, ok := parseClientAddr(clientHost)
	if !ok || !publicAddr(addr) {
		return false
	}
	s.addString(addr.Unmap().WithZone("").String())
	return true
}

// empty reports whether no register is set.
func (s *hll) empty() bool {
	for _, r := range s.reg {
		if r != 0 {
			return false
		}
	}
	return true
}

// merge takes the element-wise max of o into s.
func (s *hll) merge(o *hll) {
	for i, r := range o.reg {
		if r > s.reg[i] {
			s.reg[i] = r
		}
	}
}

// estimate is the cardinality estimate (see the contract above).
func (s *hll) estimate() int64 { return hllEstimate(s.reg[:]) }

func hllEstimate(reg []uint8) int64 {
	m := float64(len(reg))
	var sum float64
	zeros := 0
	for _, r := range reg {
		sum += math.Ldexp(1, -int(r))
		if r == 0 {
			zeros++
		}
	}
	alpha := 0.7213 / (1 + 1.079/m)
	e := alpha * m * m / sum
	if e <= 2.5*m && zeros > 0 {
		e = m * math.Log(m/float64(zeros))
	}
	if e < 0 || math.IsNaN(e) {
		return 0
	}
	return int64(math.Round(e))
}

// encode is the base64 of the 4096 register bytes, "" for an empty sketch (nothing to send).
func (s *hll) encode() string {
	if s.empty() {
		return ""
	}
	return base64.StdEncoding.EncodeToString(s.reg[:])
}

// decodeHLL parses an encoded sketch; ok is false unless it is exactly hllM bytes.
func decodeHLL(b64 string) (*hll, bool) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) != hllM {
		return nil, false
	}
	s := newHLL()
	copy(s.reg[:], raw)
	return s, true
}

// encodeOrEmpty is encode that tolerates a nil sketch (a domain that saw no countable visitor).
func (s *hll) encodeOrEmpty() string {
	if s == nil {
		return ""
	}
	return s.encode()
}
