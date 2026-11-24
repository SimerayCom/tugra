package scan

// markerPaths: a marker id is reported when ANY of its host paths exists. These are install locations of the
// platforms, panels and tools the report names; presence is a hint, never proof of a healthy install.
var markerPaths = []struct {
	id    string
	paths []string
}{
	{"coolify", []string{"/data/coolify"}},
	{"dokploy", []string{"/etc/dokploy"}},
	{"cloudpanel", []string{"/usr/bin/clpctl", "/home/clp"}},
	{"cpanel", []string{"/usr/local/cpanel"}},
	{"plesk", []string{"/usr/local/psa"}},
	{"directadmin", []string{"/usr/local/directadmin"}},
	{"hestia", []string{"/usr/local/hestia"}},
	{"tailscale", []string{"/usr/bin/tailscale", "/usr/sbin/tailscaled"}},
	{"pm2", []string{"/usr/bin/pm2", "/usr/local/bin/pm2"}},
	{"nginx", []string{"/usr/sbin/nginx"}},
	{"apache", []string{"/usr/sbin/apache2", "/usr/sbin/httpd"}},
	{"caddy", []string{"/usr/bin/caddy"}},
}

func collectMarkers(fs rootFS) []string {
	out := []string{}
	for _, m := range markerPaths {
		for _, p := range m.paths {
			if fs.exists(p) {
				out = append(out, m.id)
				break
			}
		}
	}
	return out
}
