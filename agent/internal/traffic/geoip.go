package traffic

import (
	"net/netip"
	"os"
	"strings"
)

const maxCityLen = 64

const (
	// DefaultGeoIPPath is where an operator drops a MaxMind-format country database (a DB-IP Lite
	// Country mmdb works too). TUGRA_GEOIP_DB overrides the whole lookup order.
	DefaultGeoIPPath = "/etc/tugra/geoip/country.mmdb"
	// CityGeoIPPath is where an operator drops a City edition database; it additionally yields the city
	// dimension and wins over the country databases.
	CityGeoIPPath = "/etc/tugra/geoip/city.mmdb"
	// BakedGeoIPPath is the DB-IP Lite Country database baked into the agent image at build time, so country
	// geo works out of the box. It is read-only data on local disk; nothing is ever fetched at runtime.
	BakedGeoIPPath = "/usr/share/tugra/geoip/country.mmdb"
	geoIPEnv       = "TUGRA_GEOIP_DB"
)

// geoIPDefaults is the lookup order after the TUGRA_GEOIP_DB override: an operator-supplied City edition, an
// operator-supplied country database, then the baked-in default. A variable so tests can point it at temp files.
var geoIPDefaults = []string{CityGeoIPPath, DefaultGeoIPPath, BakedGeoIPPath}

// geoIPCandidates is the full lookup order: the TUGRA_GEOIP_DB override (when set), then geoIPDefaults.
func geoIPCandidates(envPath string) []string {
	c := make([]string, 0, 1+len(geoIPDefaults))
	if envPath != "" {
		c = append(c, envPath)
	}
	return append(c, geoIPDefaults...)
}

// geo resolves an IP to an ISO-3166 alpha-2 country code against a LOCAL database. The lookup never
// touches the network. A nil *geo (no database) is valid and resolves everything to "" (unknown).
type geo struct {
	r *mmdbReader
}

// loadGeo opens the first database in the lookup order (see geoIPCandidates) that exists and is readable.
// It returns nil when none is, which just disables the geo breakdowns.
func loadGeo() *geo {
	return loadGeoFrom(geoIPCandidates(os.Getenv(geoIPEnv)))
}

// loadGeoFrom returns the first candidate that opens as a valid database. An unreadable or corrupt file is
// skipped, so a broken operator file falls through to the next candidate instead of disabling geo.
func loadGeoFrom(paths []string) *geo {
	for _, p := range paths {
		if g := openGeo(p); g != nil {
			return g
		}
	}
	return nil
}

func openGeo(path string) *geo {
	if path == "" {
		return nil
	}
	r, err := openMMDB(path)
	if err != nil {
		return nil
	}
	return &geo{r: r}
}

func (g *geo) close() {
	if g != nil && g.r != nil {
		_ = g.r.close()
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
	// The country (country.iso_code) and, for a City edition, the English city name (city.names.en). A
	// country-only database simply has no city record.
	off, found := g.r.find(addr)
	if !found {
		return "", ""
	}
	if iso, ok := g.r.lookupAt(off, "country", "iso_code"); ok {
		cc := strings.ToUpper(iso)
		if len(cc) == 2 && cc[0] >= 'A' && cc[0] <= 'Z' && cc[1] >= 'A' && cc[1] <= 'Z' {
			code = cc
		}
	}
	if wantCity {
		if name, ok := g.r.lookupAt(off, "city", "names", "en"); ok {
			city = cleanLabel(name, maxCityLen)
		}
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
