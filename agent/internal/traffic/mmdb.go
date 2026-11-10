package traffic

import (
	"bytes"
	"errors"
	"math"
	"math/big"
	"net/netip"
	"sync"
)

// A small, dependency-free reader of the MaxMind DB (.mmdb) binary format, written from the public format
// specification. It supports exactly what a local GeoIP lookup needs: the metadata map, the binary search
// tree (24/28/32-bit records, IPv4 and IPv6 trees, IPv4 addresses looked up inside an IPv6 tree) and the
// data section (every type a geo database uses, pointers followed). Every access is bounds-checked: a
// malformed or truncated file yields an error, never a panic or an out-of-range read.

const (
	mmdbMetaMarker   = "\xab\xcd\xefMaxMind.com"
	mmdbMaxMetaBytes = 128 * 1024 // the spec caps the metadata section at 128 KiB
	mmdbSeparator    = 16         // zero bytes between the search tree and the data section
	mmdbMaxDepth     = 32         // nesting bound while decoding / skipping (maps in arrays in maps ...)
)

// data-section type codes.
const (
	mmdbPointer   = 1
	mmdbString    = 2
	mmdbDouble    = 3
	mmdbBytes     = 4
	mmdbUint16    = 5
	mmdbUint32    = 6
	mmdbMap       = 7
	mmdbInt32     = 8
	mmdbUint64    = 9
	mmdbUint128   = 10
	mmdbArray     = 11
	mmdbContainer = 12
	mmdbEndMarker = 13
	mmdbBoolean   = 14
	mmdbFloat     = 15
)

var errMMDB = errors.New("mmdb: invalid or truncated database")

// mmdbReader is an open database. It is safe for concurrent lookups; close waits for them.
type mmdbReader struct {
	mu      sync.RWMutex
	file    []byte // whole file (possibly memory-mapped); nil once closed
	release func() error

	tree      []byte // search tree
	data      decoder
	nodeCount uint32
	recBits   uint32 // 24, 28 or 32
	nodeBytes uint32
	ipVersion uint16
	v4Start   uint32 // node reached after 96 zero bits, for IPv4 lookups in an IPv6 tree
}

// openMMDB opens and validates a database file.
func openMMDB(path string) (*mmdbReader, error) {
	b, release, err := mapFile(path)
	if err != nil {
		return nil, err
	}
	r, err := newMMDB(b)
	if err != nil {
		_ = release()
		return nil, err
	}
	r.release = release
	return r, nil
}

// newMMDB parses a database held in memory.
func newMMDB(b []byte) (*mmdbReader, error) {
	// The metadata sits at the end of the file, after the LAST occurrence of the marker.
	i := bytes.LastIndex(b, []byte(mmdbMetaMarker))
	if i < 0 {
		return nil, errMMDB
	}
	metaStart := i + len(mmdbMetaMarker)
	meta := b[metaStart:]
	if len(meta) > mmdbMaxMetaBytes {
		meta = meta[:mmdbMaxMetaBytes]
	}
	md := decoder{b: meta}
	v, _, err := md.decode(0, 0)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errMMDB
	}
	nodeCount, ok1 := asUint(m["node_count"])
	recSize, ok2 := asUint(m["record_size"])
	ipVer, ok3 := asUint(m["ip_version"])
	if !ok1 || !ok2 || !ok3 || nodeCount == 0 || nodeCount > math.MaxUint32 ||
		(recSize != 24 && recSize != 28 && recSize != 32) || (ipVer != 4 && ipVer != 6) {
		return nil, errMMDB
	}
	r := &mmdbReader{file: b, nodeCount: uint32(nodeCount), recBits: uint32(recSize), ipVersion: uint16(ipVer)}
	r.nodeBytes = r.recBits / 4 // two records per node
	treeSize := uint64(r.nodeCount) * uint64(r.nodeBytes)
	if treeSize+mmdbSeparator > uint64(i) {
		return nil, errMMDB // the tree and separator must fit before the metadata marker
	}
	r.tree = b[:treeSize]
	r.data = decoder{b: b[treeSize+mmdbSeparator : i]}
	if r.ipVersion == 6 {
		node := uint32(0)
		for depth := 0; depth < 96 && node < r.nodeCount; depth++ {
			if node, err = r.record(node, 0); err != nil {
				return nil, err
			}
		}
		r.v4Start = node
	}
	return r, nil
}

// close releases the file; lookups after close report "not found".
func (r *mmdbReader) close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file == nil {
		return nil
	}
	r.file, r.tree, r.data = nil, nil, decoder{}
	if r.release != nil {
		return r.release()
	}
	return nil
}

// record returns the left (bit 0) or right (bit 1) record of a node.
func (r *mmdbReader) record(node uint32, bit byte) (uint32, error) {
	off := uint64(node) * uint64(r.nodeBytes)
	if node >= r.nodeCount || off+uint64(r.nodeBytes) > uint64(len(r.tree)) {
		return 0, errMMDB
	}
	n := r.tree[off : off+uint64(r.nodeBytes)]
	switch r.recBits {
	case 24:
		if bit == 0 {
			return uint32(n[0])<<16 | uint32(n[1])<<8 | uint32(n[2]), nil
		}
		return uint32(n[3])<<16 | uint32(n[4])<<8 | uint32(n[5]), nil
	case 28:
		// The middle byte is shared: its high nibble extends the left record, its low nibble the right one.
		if bit == 0 {
			return uint32(n[3]>>4)<<24 | uint32(n[0])<<16 | uint32(n[1])<<8 | uint32(n[2]), nil
		}
		return uint32(n[3]&0x0f)<<24 | uint32(n[4])<<16 | uint32(n[5])<<8 | uint32(n[6]), nil
	default: // 32
		o := 0
		if bit == 1 {
			o = 4
		}
		return uint32(n[o])<<24 | uint32(n[o+1])<<16 | uint32(n[o+2])<<8 | uint32(n[o+3]), nil
	}
}

// find walks the search tree for ip. When the address has a record it returns the offset of its data
// (relative to the data section) and true. A miss, an IPv6 address in an IPv4-only tree, or any structural
// problem returns false.
func (r *mmdbReader) find(ip netip.Addr) (off int, found bool) {
	if r == nil {
		return 0, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.file == nil || !ip.IsValid() {
		return 0, false
	}
	ip = ip.Unmap() // ::ffff:a.b.c.d is the IPv4 address a.b.c.d
	var bits []byte
	node := uint32(0)
	if ip.Is4() {
		a := ip.As4()
		bits = a[:]
		if r.ipVersion == 6 {
			node = r.v4Start
		}
	} else {
		if r.ipVersion == 4 {
			return 0, false
		}
		a := ip.As16()
		bits = a[:]
	}
	total := len(bits) * 8
	for i := 0; i < total && node < r.nodeCount; i++ {
		bit := (bits[i>>3] >> (7 - uint(i&7))) & 1
		next, err := r.record(node, bit)
		if err != nil {
			return 0, false
		}
		node = next
	}
	if node <= r.nodeCount {
		return 0, false // == nodeCount: no data for this network; < nodeCount: ran out of address bits
	}
	d := uint64(node) - uint64(r.nodeCount) - mmdbSeparator
	if d >= uint64(len(r.data.b)) {
		return 0, false
	}
	return int(d), true
}

// lookupAt returns the string at the given map-key path inside the record at off (as returned by find).
// ok is false on a missing key or a value that is not a string.
func (r *mmdbReader) lookupAt(off int, path ...string) (s string, ok bool) {
	if r == nil {
		return "", false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.file == nil {
		return "", false
	}
	return r.data.stringAt(off, path...)
}

// lookupString finds ip and returns the string at the given map-key path inside its record.
func (r *mmdbReader) lookupString(ip netip.Addr, path ...string) (string, bool) {
	off, found := r.find(ip)
	if !found {
		return "", false
	}
	return r.lookupAt(off, path...)
}

// decoder reads values from one data section (or from the metadata section, whose pointers are relative to
// its own start).
type decoder struct{ b []byte }

// header reads a value's control bytes at off. For a pointer, size holds the (already resolved) target
// offset; otherwise size is the payload size (or the element count for maps/arrays, the value for booleans).
func (d decoder) header(off int) (typ int, size int, next int, err error) {
	if off < 0 || off >= len(d.b) {
		return 0, 0, 0, errMMDB
	}
	ctrl := d.b[off]
	off++
	typ = int(ctrl >> 5)
	if typ == mmdbPointer {
		ss := int(ctrl>>3) & 3
		v := int(ctrl & 7)
		n := ss + 1
		if ss == 3 {
			n, v = 4, 0
		}
		if off+n > len(d.b) {
			return 0, 0, 0, errMMDB
		}
		for i := 0; i < n; i++ {
			v = v<<8 | int(d.b[off+i])
		}
		switch ss {
		case 1:
			v += 2048
		case 2:
			v += 526336
		}
		return mmdbPointer, v, off + n, nil
	}
	if typ == 0 { // extended type: the next byte holds type-7
		if off >= len(d.b) {
			return 0, 0, 0, errMMDB
		}
		typ = 7 + int(d.b[off])
		off++
		if typ < 8 { // an extended type must be >= 8
			return 0, 0, 0, errMMDB
		}
	}
	size = int(ctrl & 0x1f)
	var extra, base int
	switch {
	case size == 29:
		extra, base = 1, 29
	case size == 30:
		extra, base = 2, 285
	case size == 31:
		extra, base = 3, 65821
	}
	if extra > 0 {
		if off+extra > len(d.b) {
			return 0, 0, 0, errMMDB
		}
		v := 0
		for i := 0; i < extra; i++ {
			v = v<<8 | int(d.b[off+i])
		}
		size = base + v
		off += extra
	}
	return typ, size, off, nil
}

// decode reads the value at off and returns it with the offset just past it. Pointers are followed (a
// pointer never points at another pointer). Maps become map[string]any, arrays []any, strings string,
// integers uint64 (int32 as int32, uint128 as *big.Int), floats float64, booleans bool, bytes []byte.
func (d decoder) decode(off, depth int) (any, int, error) {
	if depth > mmdbMaxDepth {
		return nil, 0, errMMDB
	}
	typ, size, next, err := d.header(off)
	if err != nil {
		return nil, 0, err
	}
	if typ == mmdbPointer {
		v, _, err := d.decodeTarget(size, depth)
		return v, next, err // continue after the pointer itself, not after its target
	}
	return d.decodeBody(typ, size, next, depth)
}

func (d decoder) decodeTarget(target, depth int) (any, int, error) {
	typ, size, next, err := d.header(target)
	if err != nil || typ == mmdbPointer {
		return nil, 0, errMMDB
	}
	return d.decodeBody(typ, size, next, depth)
}

func (d decoder) decodeBody(typ, size, off, depth int) (any, int, error) {
	if size < 0 {
		return nil, 0, errMMDB
	}
	need := func(n int) ([]byte, error) {
		if n < 0 || off > len(d.b) || n > len(d.b)-off {
			return nil, errMMDB
		}
		return d.b[off : off+n], nil
	}
	switch typ {
	case mmdbString:
		p, err := need(size)
		if err != nil {
			return nil, 0, err
		}
		return string(p), off + size, nil
	case mmdbBytes:
		p, err := need(size)
		if err != nil {
			return nil, 0, err
		}
		return append([]byte(nil), p...), off + size, nil
	case mmdbDouble:
		if size != 8 {
			return nil, 0, errMMDB
		}
		p, err := need(8)
		if err != nil {
			return nil, 0, err
		}
		return math.Float64frombits(beUint(p)), off + 8, nil
	case mmdbFloat:
		if size != 4 {
			return nil, 0, errMMDB
		}
		p, err := need(4)
		if err != nil {
			return nil, 0, err
		}
		return float64(math.Float32frombits(uint32(beUint(p)))), off + 4, nil
	case mmdbUint16, mmdbUint32, mmdbUint64, mmdbInt32, mmdbUint128:
		max := map[int]int{mmdbUint16: 2, mmdbUint32: 4, mmdbUint64: 8, mmdbInt32: 4, mmdbUint128: 16}[typ]
		if size > max {
			return nil, 0, errMMDB
		}
		p, err := need(size)
		if err != nil {
			return nil, 0, err
		}
		switch typ {
		case mmdbUint128:
			return new(big.Int).SetBytes(p), off + size, nil
		case mmdbInt32:
			// Stored big-endian with leading zero bytes dropped; a full 4 bytes carries the sign.
			return int32(uint32(beUint(p))), off + size, nil
		}
		return beUint(p), off + size, nil
	case mmdbBoolean:
		if size > 1 {
			return nil, 0, errMMDB
		}
		return size == 1, off, nil // the value is in the size field; no payload
	case mmdbMap:
		// Every entry takes >= 2 bytes, so a count beyond the remaining bytes is corrupt (and must not drive
		// an allocation).
		if size > (len(d.b)-off)/2 {
			return nil, 0, errMMDB
		}
		m := make(map[string]any, size)
		for i := 0; i < size; i++ {
			k, n, err := d.decode(off, depth+1)
			if err != nil {
				return nil, 0, err
			}
			ks, ok := k.(string)
			if !ok {
				return nil, 0, errMMDB
			}
			v, n2, err := d.decode(n, depth+1)
			if err != nil {
				return nil, 0, err
			}
			m[ks], off = v, n2
		}
		return m, off, nil
	case mmdbArray:
		if size > len(d.b)-off {
			return nil, 0, errMMDB
		}
		a := make([]any, 0, size)
		for i := 0; i < size; i++ {
			v, n, err := d.decode(off, depth+1)
			if err != nil {
				return nil, 0, err
			}
			a, off = append(a, v), n
		}
		return a, off, nil
	}
	return nil, 0, errMMDB // container / end marker / unknown type
}

// skip returns the offset just past the value at off without decoding it (a pointer is skipped as just its
// own bytes). It is what lets a path lookup pass over the many fields of a city record cheaply.
func (d decoder) skip(off, depth int) (int, error) {
	if depth > mmdbMaxDepth {
		return 0, errMMDB
	}
	typ, size, next, err := d.header(off)
	if err != nil {
		return 0, err
	}
	switch typ {
	case mmdbPointer, mmdbBoolean:
		return next, nil
	case mmdbMap, mmdbArray:
		n := size
		if typ == mmdbMap {
			if n > len(d.b) { // bound the multiplication; a valid count is far below the file size
				return 0, errMMDB
			}
			n *= 2
		}
		if n > len(d.b)-next {
			return 0, errMMDB
		}
		for i := 0; i < n; i++ {
			if next, err = d.skip(next, depth+1); err != nil {
				return 0, err
			}
		}
		return next, nil
	case mmdbString, mmdbBytes, mmdbDouble, mmdbFloat, mmdbUint16, mmdbUint32, mmdbUint64, mmdbInt32, mmdbUint128:
		if size > len(d.b)-next {
			return 0, errMMDB
		}
		return next + size, nil
	}
	return 0, errMMDB
}

// resolve follows a pointer at off (if there is one) and returns the offset of the actual value.
func (d decoder) resolve(off int) (int, error) {
	typ, size, _, err := d.header(off)
	if err != nil {
		return 0, err
	}
	if typ == mmdbPointer {
		if t, _, _, err := d.header(size); err != nil || t == mmdbPointer {
			return 0, errMMDB
		}
		return size, nil
	}
	return off, nil
}

// child returns the offset of the value stored under key in the map at off.
func (d decoder) child(off int, key string) (int, bool) {
	mo, err := d.resolve(off)
	if err != nil {
		return 0, false
	}
	typ, size, p, err := d.header(mo)
	if err != nil || typ != mmdbMap || size > (len(d.b)-p)/2 {
		return 0, false
	}
	for i := 0; i < size; i++ {
		kb, n, ok := d.stringRef(p)
		if !ok {
			return 0, false
		}
		if string(kb) == key {
			return n, true
		}
		if p, err = d.skip(n, 1); err != nil {
			return 0, false
		}
	}
	return 0, false
}

// stringAt follows the map-key path from off and returns the string found there.
func (d decoder) stringAt(off int, path ...string) (string, bool) {
	for _, k := range path {
		var ok bool
		if off, ok = d.child(off, k); !ok {
			return "", false
		}
	}
	b, _, ok := d.stringRef(off)
	if !ok {
		return "", false
	}
	return string(b), true
}

// stringRef reads the string at off (directly, or through a pointer) WITHOUT decoding anything else, and
// returns its bytes and the offset just past the reference. A value of any other type is rejected after its
// header only, so a crafted file cannot make a lookup expand a deep or wide pointer graph.
func (d decoder) stringRef(off int) ([]byte, int, bool) {
	typ, size, next, err := d.header(off)
	if err != nil {
		return nil, 0, false
	}
	after := next // where the reference ends: past the pointer's own bytes
	if typ == mmdbPointer {
		// A pointer never points at another pointer.
		if typ, size, next, err = d.header(size); err != nil || typ == mmdbPointer {
			return nil, 0, false
		}
	} else {
		after = -1 // direct string: the reference ends after the payload, set below
	}
	if typ != mmdbString || size < 0 || size > len(d.b)-next {
		return nil, 0, false
	}
	if after < 0 {
		after = next + size
	}
	return d.b[next : next+size], after, true
}

func beUint(p []byte) uint64 {
	var v uint64
	for _, c := range p {
		v = v<<8 | uint64(c)
	}
	return v
}

func asUint(v any) (uint64, bool) {
	switch n := v.(type) {
	case uint64:
		return n, true
	case int32:
		if n >= 0 {
			return uint64(n), true
		}
	}
	return 0, false
}
