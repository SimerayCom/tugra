package traffic

import (
	"sort"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	windowSec = 60

	maxDomainsPerFlush = 200    // hosts sent per window (top by requests)
	maxHostKeys        = 2000   // distinct hosts tracked while a window accumulates (flood bound); the rest fold into otherHost
	maxUnroutedKeys    = 100    // of those, at most this many may be first created by router-less (unmatched) requests
	maxPathsPerDomain  = 50     // paths sent per domain; the rest fold into otherPath
	maxPathKeys        = 1000   // distinct paths tracked per domain while accumulating
	maxCountries       = 50     // countries sent per domain; the rest fold into otherCountry
	maxDimSent         = 50     // entries sent per extra dimension (browser, os, device, referrer, city, network) per domain
	maxDimKeys         = 500    // distinct keys tracked per dimension per domain while accumulating
	maxDimKeysTotal    = 100000 // distinct dimension keys tracked across the whole window (flood bound); the rest fold into otherDim

	otherPath    = "(other)"
	otherCountry = "ZZ" // ISO "unknown/other" code used as the overflow bucket
	otherDim     = "(other)"
)

// dimCounts is one dimension's key -> request count map.
type dimCounts map[string]int64

// dims are the per-request labels beyond path/status/country. Every field is already a locally derived,
// bounded label (never a raw UA, Referer or IP). The zero value contributes nothing.
type dims struct {
	hasUA               bool
	browser, os, device string
	bot                 bool
	referrer            string // "" = not counted
	city, network       string // "" = not counted
	hasLat              bool
	lat                 int
	visitor             string // raw client address, hashed into the unique sketch and dropped; "" = not counted
}

type pathAcc struct{ n, b int64 }

type domainAcc struct {
	requests, s2xx, s3xx, s4xx, s5xx, bytes int64
	paths                                   map[string]*pathAcc
	countries                               map[string]int64

	browsers, oses, devices, referrers, cities, networks dimCounts
	human, bot                                           int64
	latency                                              [len(protocol.TrafficLatencyBucketsMs) + 1]int64
	latN                                                 int64
	uniq                                                 *hll // unique-visitor sketch (registers only, never an address); nil until a visitor is added
}

// aggregator accumulates one delta window. It is not safe for concurrent use: a collector is owned by a
// single goroutine.
type aggregator struct {
	start    time.Time
	domains  map[string]*domainAcc
	total    int64 // countable requests this window
	dimKeys  int   // distinct dimension keys currently tracked this window (flood bound)
	unrouted int   // host keys first created by a router-less request this window
}

func newDomainAcc() *domainAcc {
	return &domainAcc{paths: map[string]*pathAcc{}, countries: map[string]int64{}}
}

func newAggregator(now time.Time) *aggregator {
	return &aggregator{start: now, domains: map[string]*domainAcc{}}
}

// add folds one routed record in. country is the already-resolved ISO code ("" when unknown); the client
// address is not part of the record the aggregator sees.
func (a *aggregator) add(host, path string, status int, bytes int64, country string) {
	a.addRecord(host, path, status, bytes, country, false)
}

// addRecord is add with the router-less flag. Hosts of router-less requests are attacker-chosen (scanners
// send random Host headers), so they may create only a few host keys; once a bound is hit a new host folds
// into otherHost instead of being dropped, so totals still reconcile and a routed app is never starved of
// its own row by junk hosts.
func (a *aggregator) addRecord(host, path string, status int, bytes int64, country string, unrouted bool) {
	a.addFull(host, path, status, bytes, country, unrouted, dims{})
}

// addFull is addRecord plus the extra dimensions. Each dimension has the same cap discipline as paths and
// countries: bounded tracked keys, top maxDimSent sent, the remainder folded into otherDim.
func (a *aggregator) addFull(host, path string, status int, bytes int64, country string, unrouted bool, x dims) {
	d := a.domains[host]
	if d == nil {
		if len(a.domains) >= maxHostKeys || (unrouted && a.unrouted >= maxUnroutedKeys) {
			host = otherHost
			d = a.domains[host]
		} else if unrouted {
			a.unrouted++
		}
		if d == nil {
			d = newDomainAcc()
			a.domains[host] = d
		}
	}
	a.total++
	d.requests++
	switch status / 100 {
	case 2:
		d.s2xx++
	case 3:
		d.s3xx++
	case 4:
		d.s4xx++
	case 5:
		d.s5xx++
	}
	d.bytes += bytes

	key := path
	if _, ok := d.paths[key]; !ok && len(d.paths) >= maxPathKeys {
		// Space-saving style: instead of folding every later new path (first-seen wins), drop the tail of
		// the table so a path that turns heavy late in the window still gets a slot.
		pruneStats(d.paths)
	}
	pa := d.paths[key]
	if pa == nil {
		pa = &pathAcc{}
		d.paths[key] = pa
	}
	pa.n++
	pa.b += bytes

	if country != "" {
		d.countries[country]++
	}

	if x.hasUA {
		a.bump(&d.browsers, x.browser, 1)
		a.bump(&d.oses, x.os, 1)
		a.bump(&d.devices, x.device, 1)
		if x.bot {
			d.bot++
		} else {
			d.human++
		}
	}
	if x.referrer != "" {
		a.bump(&d.referrers, x.referrer, 1)
	}
	if x.city != "" {
		a.bump(&d.cities, x.city, 1)
	}
	if x.network != "" {
		a.bump(&d.networks, x.network, 1)
	}
	if x.visitor != "" {
		if d.uniq == nil {
			d.uniq = newHLL()
		}
		d.uniq.addClient(x.visitor)
	}
	if x.hasLat && x.lat >= 0 && x.lat < len(d.latency) {
		d.latency[x.lat]++
		d.latN++
	}
}

// bump adds n to key in one dimension map, creating it lazily. The table is bounded (per dimension and
// window-wide) against a flood of attacker-chosen values (random Referer hosts, scattered source networks),
// but it is NOT first-seen-wins: when it fills up, the tail is pruned (the busiest half is kept, the rest
// folds into otherDim) so a key that turns heavy late in the window still gets a slot and the top-N
// ranking at flush is not biased toward early arrivals. Totals always reconcile.
func (a *aggregator) bump(m *dimCounts, key string, n int64) {
	if *m == nil {
		*m = dimCounts{}
	}
	if _, ok := (*m)[key]; !ok {
		if len(*m) >= maxDimKeys || a.dimKeys >= maxDimKeysTotal {
			a.pruneDim(*m)
		}
		if a.dimKeys >= maxDimKeysTotal {
			key = otherDim
			if _, ok := (*m)[key]; !ok {
				a.dimKeys++ // the overflow row itself is one tracked key
			}
		} else {
			a.dimKeys++
		}
	}
	(*m)[key] += n
}

// pruneDim keeps the busiest maxDimKeys/2 keys of one dimension and folds the rest into otherDim, so the
// table has room again (amortized: a prune frees at least half the table).
func (a *aggregator) pruneDim(m dimCounts) {
	keep := maxDimKeys / 2
	type kv struct {
		k string
		n int64
	}
	items := make([]kv, 0, len(m))
	for k, n := range m {
		if k != otherDim {
			items = append(items, kv{k, n})
		}
	}
	if len(items) <= keep {
		return
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].n != items[j].n {
			return items[i].n > items[j].n
		}
		return items[i].k < items[j].k
	})
	var rest int64
	for _, it := range items[keep:] {
		rest += it.n
		delete(m, it.k)
	}
	a.dimKeys -= len(items) - keep
	if _, ok := m[otherDim]; !ok {
		a.dimKeys++
	}
	m[otherDim] += rest
}

// pruneStats is pruneDim for the path table: keep the busiest maxPathKeys/2 paths, fold the rest into
// otherPath (requests and bytes).
func pruneStats(m map[string]*pathAcc) {
	keep := maxPathKeys / 2
	type kv struct {
		p string
		a *pathAcc
	}
	items := make([]kv, 0, len(m))
	for p, a := range m {
		if p != otherPath {
			items = append(items, kv{p, a})
		}
	}
	if len(items) <= keep {
		return
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].a.n != items[j].a.n {
			return items[i].a.n > items[j].a.n
		}
		return items[i].p < items[j].p
	})
	rest := m[otherPath]
	if rest == nil {
		rest = &pathAcc{}
		m[otherPath] = rest
	}
	for _, it := range items[keep:] {
		rest.n += it.a.n
		rest.b += it.a.b
		delete(m, it.p)
	}
}

// flush emits the window and starts the next one at now. It returns nil when nothing was countable (the
// window is still advanced so Ts always marks the true start of what is sent).
func (a *aggregator) flush(now time.Time) *protocol.TrafficMetrics {
	start := a.start
	domains := a.domains
	total := a.total
	a.start = now
	a.domains = map[string]*domainAcc{}
	a.total = 0
	a.dimKeys = 0
	a.unrouted = 0
	if total == 0 {
		return nil
	}

	// otherHost is the overflow bucket: it is never ranked, it is sent last and also absorbs the hosts
	// that fall below the per-flush cap.
	other := domains[otherHost]
	hosts := make([]string, 0, len(domains))
	for h := range domains {
		if h != otherHost {
			hosts = append(hosts, h)
		}
	}
	sort.Slice(hosts, func(i, j int) bool {
		di, dj := domains[hosts[i]], domains[hosts[j]]
		if di.requests != dj.requests {
			return di.requests > dj.requests
		}
		return hosts[i] < hosts[j]
	})
	if len(hosts) > maxDomainsPerFlush {
		if other == nil {
			other = newDomainAcc()
		}
		for _, h := range hosts[maxDomainsPerFlush:] {
			other.fold(domains[h])
		}
		hosts = hosts[:maxDomainsPerFlush]
	}

	out := &protocol.TrafficMetrics{
		Type:      "traffic_metrics",
		Ts:        start.UnixMilli(),
		WindowSec: windowSec,
		Domains:   make([]protocol.TrafficDomainStat, 0, len(hosts)),
	}
	stat := func(h string, d *domainAcc) protocol.TrafficDomainStat {
		return protocol.TrafficDomainStat{
			Host:      h,
			Requests:  d.requests,
			S2xx:      d.s2xx,
			S3xx:      d.s3xx,
			S4xx:      d.s4xx,
			S5xx:      d.s5xx,
			Bytes:     d.bytes,
			Paths:     topPaths(d.paths),
			Countries: topCountries(d.countries),

			Browsers:  topKeys(d.browsers),
			OS:        topKeys(d.oses),
			Devices:   topKeys(d.devices),
			Referrers: topKeys(d.referrers),
			Cities:    topKeys(d.cities),
			Networks:  topKeys(d.networks),
			Bots:      botSplit(d),
			Latency:   latencyCounts(d),
			Unique:    d.uniq.encodeOrEmpty(),
		}
	}
	for _, h := range hosts {
		out.Domains = append(out.Domains, stat(h, domains[h]))
	}
	if other != nil {
		out.Domains = append(out.Domains, stat(otherHost, other))
	}
	return out
}

// fold adds src's counters into d. Paths are not carried over individually: the folded hosts' traffic
// lands on a single otherPath row.
func (d *domainAcc) fold(src *domainAcc) {
	d.requests += src.requests
	d.s2xx += src.s2xx
	d.s3xx += src.s3xx
	d.s4xx += src.s4xx
	d.s5xx += src.s5xx
	d.bytes += src.bytes
	pa := d.paths[otherPath]
	if pa == nil {
		pa = &pathAcc{}
		d.paths[otherPath] = pa
	}
	pa.n += src.requests
	pa.b += src.bytes
	for c, n := range src.countries {
		d.countries[c] += n
	}
	// Dimensions carry over (counts only); folding happens at emit time via topKeys. This runs only at
	// flush, so the per-dimension key bound is applied there rather than through a.bump.
	d.browsers = mergeDim(d.browsers, src.browsers)
	d.oses = mergeDim(d.oses, src.oses)
	d.devices = mergeDim(d.devices, src.devices)
	d.referrers = mergeDim(d.referrers, src.referrers)
	d.cities = mergeDim(d.cities, src.cities)
	d.networks = mergeDim(d.networks, src.networks)
	d.human += src.human
	d.bot += src.bot
	d.latN += src.latN
	for i, n := range src.latency {
		d.latency[i] += n
	}
	if src.uniq != nil {
		if d.uniq == nil {
			d.uniq = newHLL()
		}
		d.uniq.merge(src.uniq)
	}
}

func mergeDim(dst, src dimCounts) dimCounts {
	if len(src) == 0 {
		return dst
	}
	if dst == nil {
		dst = dimCounts{}
	}
	for k, n := range src {
		dst[k] += n
	}
	return dst
}

// topKeys keeps the busiest maxDimSent keys of a dimension; the remainder (and any literal otherDim)
// folds into a single otherDim row. nil when the dimension is empty.
func topKeys(m dimCounts) []protocol.TrafficKeyCount {
	if len(m) == 0 {
		return nil
	}
	items := make([]protocol.TrafficKeyCount, 0, len(m))
	var rest int64
	for k, n := range m {
		if k == otherDim {
			rest += n
			continue
		}
		items = append(items, protocol.TrafficKeyCount{K: k, N: n})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].N != items[j].N {
			return items[i].N > items[j].N
		}
		return items[i].K < items[j].K
	})
	if len(items) > maxDimSent {
		for _, it := range items[maxDimSent:] {
			rest += it.N
		}
		items = items[:maxDimSent]
	}
	if rest > 0 {
		items = append(items, protocol.TrafficKeyCount{K: otherDim, N: rest})
	}
	return items
}

func botSplit(d *domainAcc) *protocol.TrafficBots {
	if d.human+d.bot == 0 {
		return nil
	}
	return &protocol.TrafficBots{Human: d.human, Bot: d.bot}
}

// latencyCounts is the fixed-length (14) histogram, or nil when no request carried a duration.
func latencyCounts(d *domainAcc) []int64 {
	if d.latN == 0 {
		return nil
	}
	out := make([]int64, len(d.latency))
	copy(out, d.latency[:])
	return out
}

// topPaths keeps the busiest maxPathsPerDomain paths; everything else (and any literal otherPath)
// is folded into a single otherPath row.
func topPaths(m map[string]*pathAcc) []protocol.TrafficPathStat {
	type kv struct {
		p string
		a *pathAcc
	}
	var rest pathAcc
	items := make([]kv, 0, len(m))
	for p, a := range m {
		if p == otherPath {
			rest.n += a.n
			rest.b += a.b
			continue
		}
		items = append(items, kv{p, a})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].a.n != items[j].a.n {
			return items[i].a.n > items[j].a.n
		}
		return items[i].p < items[j].p
	})
	if len(items) > maxPathsPerDomain {
		for _, it := range items[maxPathsPerDomain:] {
			rest.n += it.a.n
			rest.b += it.a.b
		}
		items = items[:maxPathsPerDomain]
	}
	out := make([]protocol.TrafficPathStat, 0, len(items)+1)
	for _, it := range items {
		out = append(out, protocol.TrafficPathStat{P: it.p, N: it.a.n, B: it.a.b})
	}
	if rest.n > 0 {
		out = append(out, protocol.TrafficPathStat{P: otherPath, N: rest.n, B: rest.b})
	}
	return out
}

// topCountries keeps the busiest maxCountries; the remainder folds into otherCountry.
func topCountries(m map[string]int64) []protocol.TrafficCountryStat {
	if len(m) == 0 {
		return nil
	}
	items := make([]protocol.TrafficCountryStat, 0, len(m))
	var rest int64
	for c, n := range m {
		if c == otherCountry {
			rest += n
			continue
		}
		items = append(items, protocol.TrafficCountryStat{C: c, N: n})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].N != items[j].N {
			return items[i].N > items[j].N
		}
		return items[i].C < items[j].C
	})
	if len(items) > maxCountries {
		for _, it := range items[maxCountries:] {
			rest += it.N
		}
		items = items[:maxCountries]
	}
	if rest > 0 {
		items = append(items, protocol.TrafficCountryStat{C: otherCountry, N: rest})
	}
	return items
}
