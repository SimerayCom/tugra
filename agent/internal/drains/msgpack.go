package drains

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"time"
)

// A deliberately minimal MessagePack implementation (clean-room from the public spec at
// https://github.com/msgpack/msgpack/blob/master/spec.md): just what the fluentd Forward protocol needs.
// Encoding: nil, bool, unsigned ints, str, bin, array/map headers and the fluentd EventTime ext type. Decoding:
// every format family, into plain Go values, with hard size/depth limits (the peer is a remote host).

// mpEnc is an append-only encoder.
type mpEnc struct{ b []byte }

func (e *mpEnc) nil_() { e.b = append(e.b, 0xc0) }

func (e *mpEnc) bool_(v bool) {
	if v {
		e.b = append(e.b, 0xc3)
	} else {
		e.b = append(e.b, 0xc2)
	}
}

// uint_ writes the smallest unsigned format: positive fixint, uint 8/16/32/64.
func (e *mpEnc) uint_(v uint64) {
	switch {
	case v <= 0x7f:
		e.b = append(e.b, byte(v))
	case v <= math.MaxUint8:
		e.b = append(e.b, 0xcc, byte(v))
	case v <= math.MaxUint16:
		e.b = append(e.b, 0xcd, byte(v>>8), byte(v))
	case v <= math.MaxUint32:
		e.b = append(e.b, 0xce, byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
	default:
		e.b = append(e.b, 0xcf)
		e.b = binary.BigEndian.AppendUint64(e.b, v)
	}
}

// str writes fixstr (<=31), str 8/16/32.
func (e *mpEnc) str(s string) {
	n := len(s)
	switch {
	case n <= 31:
		e.b = append(e.b, 0xa0|byte(n))
	case n <= math.MaxUint8:
		e.b = append(e.b, 0xd9, byte(n))
	case n <= math.MaxUint16:
		e.b = append(e.b, 0xda, byte(n>>8), byte(n))
	default:
		e.b = append(e.b, 0xdb)
		e.b = binary.BigEndian.AppendUint32(e.b, uint32(n))
	}
	e.b = append(e.b, s...)
}

// bin writes bin 8/16/32.
func (e *mpEnc) bin(p []byte) {
	n := len(p)
	switch {
	case n <= math.MaxUint8:
		e.b = append(e.b, 0xc4, byte(n))
	case n <= math.MaxUint16:
		e.b = append(e.b, 0xc5, byte(n>>8), byte(n))
	default:
		e.b = append(e.b, 0xc6)
		e.b = binary.BigEndian.AppendUint32(e.b, uint32(n))
	}
	e.b = append(e.b, p...)
}

// arrayHeader writes fixarray (<=15), array 16/32.
func (e *mpEnc) arrayHeader(n int) {
	switch {
	case n <= 15:
		e.b = append(e.b, 0x90|byte(n))
	case n <= math.MaxUint16:
		e.b = append(e.b, 0xdc, byte(n>>8), byte(n))
	default:
		e.b = append(e.b, 0xdd)
		e.b = binary.BigEndian.AppendUint32(e.b, uint32(n))
	}
}

// mapHeader writes fixmap (<=15), map 16/32 (n = number of key/value PAIRS).
func (e *mpEnc) mapHeader(n int) {
	switch {
	case n <= 15:
		e.b = append(e.b, 0x80|byte(n))
	case n <= math.MaxUint16:
		e.b = append(e.b, 0xde, byte(n>>8), byte(n))
	default:
		e.b = append(e.b, 0xdf)
		e.b = binary.BigEndian.AppendUint32(e.b, uint32(n))
	}
}

// eventTime writes fluentd's EventTime: fixext 8, type 0, uint32 seconds + uint32 nanoseconds (big endian).
func (e *mpEnc) eventTime(t time.Time) {
	e.b = append(e.b, 0xd7, 0x00)
	e.b = binary.BigEndian.AppendUint32(e.b, uint32(t.Unix()))
	e.b = binary.BigEndian.AppendUint32(e.b, uint32(t.Nanosecond()))
}

// ---- decoder ----

const (
	mpMaxLen   = 1 << 20 // longest str/bin/ext accepted from the peer
	mpMaxCount = 4096    // most array/map entries accepted from the peer
	mpMaxDepth = 8

	// Total budget of ONE decode. The peer is a remote host (a tenant-chosen sink), and a value that is 1 byte on the
	// wire can cost 16 in memory (a nil in a []any), so per-container caps alone let a 16 MB payload build ~270 MB.
	// ack / HELO / PONG are tiny, so these defaults are generous for them and hard on everything else.
	mpBudgetBytes = 64 << 10
	mpBudgetElems = 1024
	// what one decoded element is charged for its slot in a []any / map (at least).
	mpElemCost = 16
	// array/map pre-allocation never trusts the declared count beyond this.
	mpPrealloc = 64
)

var errMsgpack = errors.New("msgpack: malformed or oversized value")

// mpBudget is the running allowance of one decode: bytes consumed from the stream plus a per-element memory charge,
// and the number of decoded elements. Exceeding either is errMsgpack.
type mpBudget struct{ bytes, elems int }

func (b *mpBudget) takeBytes(n int) error {
	b.bytes -= n
	if b.bytes < 0 {
		return errMsgpack
	}
	return nil
}

func (b *mpBudget) takeElem() error {
	b.elems--
	if b.elems < 0 {
		return errMsgpack
	}
	return b.takeBytes(mpElemCost)
}

// mpExt is a decoded ext value (kept raw; the agent never needs to interpret one).
type mpExt struct {
	Type int8
	Data []byte
}

// mpDecode reads one MessagePack value with the default (small) budget. Results: nil, bool, int64 (uint64 only above
// MaxInt64), float64, string (str), []byte (bin), []any, map[string]any (non-string keys are rejected) and mpExt.
func mpDecode(r *bufio.Reader) (any, error) { return mpDecodeLimited(r, mpBudgetBytes, mpBudgetElems) }

// mpDecodeLimited is mpDecode with an explicit total byte / element budget.
func mpDecodeLimited(r *bufio.Reader, maxBytes, maxElems int) (any, error) {
	return mpDecodeDepth(r, 0, &mpBudget{bytes: maxBytes, elems: maxElems})
}

func readN(r *bufio.Reader, n int, bud *mpBudget) ([]byte, error) {
	if n < 0 || n > mpMaxLen {
		return nil, errMsgpack
	}
	if err := bud.takeBytes(n); err != nil {
		return nil, err
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	return b, nil
}

func readUint(r *bufio.Reader, size int, bud *mpBudget) (uint64, error) {
	b, err := readN(r, size, bud)
	if err != nil {
		return 0, err
	}
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v, nil
}

func mpDecodeDepth(r *bufio.Reader, depth int, bud *mpBudget) (any, error) {
	if depth > mpMaxDepth {
		return nil, errMsgpack
	}
	c, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	// every value (header byte + its slot) is charged, nil / bool / small ints included
	if err := bud.takeElem(); err != nil {
		return nil, err
	}
	if err := bud.takeBytes(1); err != nil {
		return nil, err
	}
	switch {
	case c <= 0x7f:
		return int64(c), nil
	case c >= 0xe0:
		return int64(int8(c)), nil
	case c >= 0x80 && c <= 0x8f:
		return mpMap(r, int(c&0x0f), depth, bud)
	case c >= 0x90 && c <= 0x9f:
		return mpArray(r, int(c&0x0f), depth, bud)
	case c >= 0xa0 && c <= 0xbf:
		b, err := readN(r, int(c&0x1f), bud)
		return string(b), err
	}
	switch c {
	case 0xc0:
		return nil, nil
	case 0xc2:
		return false, nil
	case 0xc3:
		return true, nil
	case 0xc4, 0xc5, 0xc6: // bin 8/16/32
		n, err := readUint(r, 1<<(c-0xc4), bud)
		if err != nil {
			return nil, err
		}
		return readN(r, int(n), bud)
	case 0xc7, 0xc8, 0xc9: // ext 8/16/32
		n, err := readUint(r, 1<<(c-0xc7), bud)
		if err != nil {
			return nil, err
		}
		return mpReadExt(r, int(n), bud)
	case 0xca: // float 32
		v, err := readUint(r, 4, bud)
		return float64(math.Float32frombits(uint32(v))), err
	case 0xcb: // float 64
		v, err := readUint(r, 8, bud)
		return math.Float64frombits(v), err
	case 0xcc, 0xcd, 0xce, 0xcf: // uint 8/16/32/64
		v, err := readUint(r, 1<<(c-0xcc), bud)
		if err != nil {
			return nil, err
		}
		if v > math.MaxInt64 {
			return v, nil
		}
		return int64(v), nil
	case 0xd0, 0xd1, 0xd2, 0xd3: // int 8/16/32/64
		size := 1 << (c - 0xd0)
		v, err := readUint(r, size, bud)
		if err != nil {
			return nil, err
		}
		shift := uint(64 - 8*size)
		return int64(v<<shift) >> shift, nil // sign-extend
	case 0xd4, 0xd5, 0xd6, 0xd7, 0xd8: // fixext 1/2/4/8/16
		return mpReadExt(r, 1<<(c-0xd4), bud)
	case 0xd9, 0xda, 0xdb: // str 8/16/32
		n, err := readUint(r, 1<<(c-0xd9), bud)
		if err != nil {
			return nil, err
		}
		b, err := readN(r, int(n), bud)
		return string(b), err
	case 0xdc, 0xdd: // array 16/32
		n, err := readUint(r, 2<<(c-0xdc), bud)
		if err != nil {
			return nil, err
		}
		return mpArray(r, int(n), depth, bud)
	case 0xde, 0xdf: // map 16/32
		n, err := readUint(r, 2<<(c-0xde), bud)
		if err != nil {
			return nil, err
		}
		return mpMap(r, int(n), depth, bud)
	}
	return nil, errMsgpack // 0xc1 is never used
}

func mpReadExt(r *bufio.Reader, n int, bud *mpBudget) (any, error) {
	t, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	b, err := readN(r, n, bud)
	return mpExt{Type: int8(t), Data: b}, err
}

// mpPre is the capacity to pre-allocate for a declared count: never more than mpPrealloc, never more than the
// elements the budget could still pay for.
func mpPre(n int, bud *mpBudget) int {
	m := n
	if m > mpPrealloc {
		m = mpPrealloc
	}
	if m > bud.elems {
		m = bud.elems
	}
	if m < 0 {
		m = 0
	}
	return m
}

func mpArray(r *bufio.Reader, n, depth int, bud *mpBudget) (any, error) {
	if n > mpMaxCount {
		return nil, errMsgpack
	}
	out := make([]any, 0, mpPre(n, bud))
	for i := 0; i < n; i++ {
		v, err := mpDecodeDepth(r, depth+1, bud)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func mpMap(r *bufio.Reader, n, depth int, bud *mpBudget) (any, error) {
	if n > mpMaxCount {
		return nil, errMsgpack
	}
	out := make(map[string]any, mpPre(n, bud))
	for i := 0; i < n; i++ {
		k, err := mpDecodeDepth(r, depth+1, bud)
		if err != nil {
			return nil, err
		}
		ks, ok := k.(string)
		if !ok {
			return nil, errMsgpack
		}
		v, err := mpDecodeDepth(r, depth+1, bud)
		if err != nil {
			return nil, err
		}
		out[ks] = v
	}
	return out, nil
}
