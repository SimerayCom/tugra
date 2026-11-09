package traffic

import (
	"net"
	"net/netip"
	"os"
	"strings"

	"github.com/oschwald/maxminddb-golang"
)

const maxCityLen = 64

const (
	// DefaultGeoIPPath is where an operator drops a MaxMind-format country database (a DB-IP Lite
	// Country mmdb works too; a City edition additionally yields the city dimension). TUGRA_GEOIP_DB overrides it.
	DefaultGeoIPPath = "/etc/tugra/geoip/country.mmdb"
	geoIPEnv         = "TUGRA_GEOIP_DB"
)

// geo resolves an IP to an ISO-3166 alpha-2 country code against a LOCAL database. The lookup never
// touches the network. A nil *geo (no database) is valid and resolves everything to "" (unknown).
type geo struct {
	r *maxminddb.Reader
}

// countryRecord reads the country and, when the database is a City edition, the English city name. A
// country-only database simply leaves City.Names empty.
type countryRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
}

// loadGeo opens the country database once. It returns nil when the database is absent or unreadable,
// which just disables the country breakdown.
func loadGeo() *geo {
	path := os.Getenv(geoIPEnv)
	if path == "" {
		path = DefaultGeoIPPath
	}
	return openGeo(path)
}

func openGeo(path string) *geo {
	if path == "" {
		return nil
	}
	r, err := maxminddb.Open(path)
	if err != nil {
		return nil
	}
	return &geo{r: r}
}

func (g *geo) close() {
	if g != nil && g.r != nil {
		_ = g.r.Close()
	}
}

// country returns the ISO code for a client address, or "" when unknown, private, malformed, or no
// database is loaded. It never panics on bad input.
func (g *geo) country(clientHost string) string {
	cc, _ := g.lookup(clientHost, false)
	return cc
}

// lookup returns the ISO country code and, when wantCity and the database is a City edition, the English
// city name; each is "" when unknown. The address is read from the local database only and goes no
// further. It never panics on bad input.
func (g *geo) lookup(clientHost string, wantCity bool) (code, city string) {
	if g == nil || g.r == nil {
		return "", ""
	}
	defer func() {
		if recover() != nil {
			code, city = "", ""
		}
	}()
	addr, ok := parseClientAddr(clientHost)
	if !ok || !publicAddr(addr) {
		return "", ""
	}
	var rec countryRecord
	if err := g.r.Lookup(net.IP(addr.AsSlice()), &rec); err != nil {
		return "", ""
	}
	cc := strings.ToUpper(rec.Country.ISOCode)
	if len(cc) == 2 && cc[0] >= 'A' && cc[0] <= 'Z' && cc[1] >= 'A' && cc[1] <= 'Z' {
		code = cc
	}
	if wantCity {
		city = cleanLabel(rec.City.Names["en"], maxCityLen)
	}
	return code, city
}

// parseClientAddr accepts a bare IP or an ip:port form.
func parseClientAddr(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return netip.Addr{}, false
	}
	if a, err := netip.ParseAddr(s); err == nil {
		return a.Unmap(), true
	}
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap(), true
	}
	return netip.Addr{}, false
}
