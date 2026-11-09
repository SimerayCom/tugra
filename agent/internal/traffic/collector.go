package traffic

import (
	"log"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// AccessLogPath is where the proxy writes the JSON access log (host path, mounted at the same path in
// the agent container). The file exists only while Traffic Analytics is enabled for the server.
const AccessLogPath = "/etc/tugra/proxy-logs/access.json"

// Collector tails the access log and produces per-window summaries. It is NOT safe for concurrent use:
// drive ingestNew/Flush from one goroutine (the traffic loop).
type Collector struct {
	tail *tailer
	geo  *geo
	agg  *aggregator
	// ipMode gates the client-address derived dimensions (city, anonymized network); see loadIPMode.
	ipMode string
}

// NewCollector reads AccessLogPath and the GeoIP database (TUGRA_GEOIP_DB or DefaultGeoIPPath, optional).
func NewCollector() *Collector {
	return newCollector(AccessLogPath, loadGeo(), time.Now())
}

func newCollector(path string, g *geo, now time.Time) *Collector {
	return &Collector{tail: newTailer(path), geo: g, agg: newAggregator(now), ipMode: loadIPMode(ipModeFile)}
}

// Close releases the GeoIP database.
func (c *Collector) Close() { c.geo.close() }

// IngestNew reads any newly appended log lines into the current window.
func (c *Collector) IngestNew() { c.ingestNew() }

func (c *Collector) ingestNew() {
	before := c.tail.dropped
	c.tail.forEachLine(func(line []byte) {
		rec, ok := parseLine(line)
		if !ok {
			return
		}
		// The client address is consumed here and goes no further than a country code, a city name and an
		// anonymized network (/24 or /48); the latter two only in "anonymized" IP mode.
		wantIP := c.ipMode != ipModeOff
		country, city := c.geo.lookup(rec.clientIP, wantIP)
		x := dims{
			hasUA: rec.hasUA, browser: rec.browser, os: rec.os, device: rec.device, bot: rec.bot,
			referrer: rec.referrer, hasLat: rec.hasLat, lat: rec.lat,
		}
		if wantIP {
			x.city = city
			x.network = anonymizeNetwork(rec.clientIP)
		}
		c.agg.addFull(rec.host, rec.path, rec.status, rec.bytes, country, rec.unrouted, x)
	})
	if d := c.tail.dropped - before; d > 0 {
		log.Printf("traffic: access-log backlog exceeded the per-pass bound; dropped %d span(s) of the oldest entries (counts for this window are low)", d)
	}
}

// Flush closes the current window and returns its summary, or nil when it held no countable request.
func (c *Collector) Flush() *protocol.TrafficMetrics { return c.flushAt(time.Now()) }

func (c *Collector) flushAt(now time.Time) *protocol.TrafficMetrics { return c.agg.flush(now) }
