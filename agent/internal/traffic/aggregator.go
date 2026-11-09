package traffic

import (
	"sort"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	windowSec = 60

	maxDomainsPerFlush = 200  // hosts sent per window (top by requests)
	maxHostKeys        = 2000 // distinct hosts tracked while a window accumulates (flood bound); the rest fold into otherHost
	maxUnroutedKeys    = 100  // of those, at most this many may be first created by router-less (unmatched) requests
	maxPathsPerDomain  = 50   // paths sent per domain; the rest fold into otherPath
	maxPathKeys        = 1000 // distinct paths tracked per domain while accumulating
	maxCountries       = 50   // countries sent per domain; the rest fold into otherCountry

	otherPath    = "(other)"
	otherCountry = "ZZ" // ISO "unknown/other" code used as the overflow bucket
)

type pathAcc struct{ n, b int64 }

type domainAcc struct {
	requests, s2xx, s3xx, s4xx, s5xx, bytes int64
	paths                                   map[string]*pathAcc
	countries                               map[string]int64
}

// aggregator accumulates one delta window. It is not safe for concurrent use: a collector is owned by a
// single goroutine.
type aggregator struct {
	start    time.Time
	domains  map[string]*domainAcc
	total    int64 // countable requests this window
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
		key = otherPath
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
