package scan

import (
	"path"
	"regexp"
	"sort"
	"strings"
)

var (
	nginxDirs  = []string{"/etc/nginx/sites-enabled", "/etc/nginx/conf.d"}
	apacheDirs = []string{"/etc/apache2/sites-enabled", "/etc/httpd/conf.d"}

	phpVerRe    = regexp.MustCompile(`php[-_]?(?:fpm)?[-_]?(\d\.\d)`)
	hostPortRe  = regexp.MustCompile(`(?:^|[^0-9])(\d{2,5})(?:/|$)`)
	siteUserRe  = regexp.MustCompile(`^/home/([^/]+)/htdocs/`)
	listenPortR = regexp.MustCompile(`(?:^|:)(\d{1,5})$`)
)

// collectSites reads the nginx and apache virtual hosts. cloudpanel marks the ones living under CloudPanel's
// /home/<site-user>/htdocs/ layout.
func collectSites(fs rootFS, cloudpanel bool, errs *[]string) []Site {
	var all []Site
	for _, dir := range nginxDirs {
		for _, f := range confFiles(fs, dir) {
			b, err := fs.readFile(f)
			if err != nil {
				continue
			}
			all = append(all, nginxSites(string(b))...)
		}
	}
	for _, dir := range apacheDirs {
		for _, f := range confFiles(fs, dir) {
			b, err := fs.readFile(f)
			if err != nil {
				continue
			}
			all = append(all, apacheSites(string(b))...)
		}
	}
	merged := mergeSites(all)
	for i := range merged {
		if cloudpanel {
			if m := siteUserRe.FindStringSubmatch(merged[i].Root); m != nil {
				merged[i].Panel = "cloudpanel"
				merged[i].SiteUser = clean(m[1], 64)
			}
		}
	}
	if len(merged) > maxSites {
		merged = merged[:maxSites]
	}
	if merged == nil {
		merged = []Site{}
	}
	return merged
}

func confFiles(fs rootFS, dir string) []string {
	names, err := fs.readDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, n := range names {
		if strings.HasPrefix(n, ".") || strings.HasSuffix(n, "~") || strings.HasSuffix(n, ".bak") || strings.HasSuffix(n, ".disabled") {
			continue
		}
		out = append(out, path.Join(dir, n))
		if len(out) >= 300 {
			break
		}
	}
	return out
}

func realName(n string) bool {
	n = strings.ToLower(strings.TrimSpace(n))
	return n != "" && n != "_" && n != "localhost" && n != "default" && !strings.HasPrefix(n, "~") && n != "*" && n != "\"\""
}

// mergeSites folds the usual http→https vhost pair (same names) into one entry and drops catch-all hosts.
func mergeSites(in []Site) []Site {
	idx := map[string]int{}
	var out []Site
	for _, s := range in {
		var names []string
		seen := map[string]bool{}
		for _, n := range s.Names {
			n = clean(strings.ToLower(n), 120)
			if realName(n) && !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
		if len(names) == 0 {
			continue
		}
		sort.Strings(names)
		s.Names = names
		key := s.Server + "|" + strings.Join(names, ",")
		if i, ok := idx[key]; ok {
			m := &out[i]
			m.SSL = m.SSL || s.SSL
			if m.Root == "" {
				m.Root = s.Root
			}
			if m.Kind == "other" || (m.Kind == "static" && s.Kind != "other") {
				m.Kind, m.Port, m.PHP = s.Kind, s.Port, s.PHP
			}
			continue
		}
		idx[key] = len(out)
		out = append(out, s)
	}
	return out
}

// ── nginx ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type ngxNode struct {
	name string
	args []string
	kids []*ngxNode
}

// ngxTokens splits nginx config text into words, quoted strings and the `{` `}` `;` punctuation, dropping comments.
func ngxTokens(s string) []string {
	var toks []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			toks = append(toks, cur.String())
			cur.Reset()
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '#':
			flush()
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '"' || c == '\'':
			flush()
			q := c
			j := i + 1
			for j < len(s) && s[j] != q {
				if s[j] == '\\' {
					j++
				}
				j++
			}
			if j > len(s) {
				j = len(s)
			}
			toks = append(toks, "\x00"+s[i+1:min(j, len(s))])
			i = j
		case c == '{' || c == '}' || c == ';':
			flush()
			toks = append(toks, string(c))
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			flush()
		default:
			cur.WriteByte(c)
		}
	}
	flush()
	return toks
}

func parseNginx(text string) []*ngxNode {
	toks := ngxTokens(text)
	pos := 0
	var block func(depth int) []*ngxNode
	block = func(depth int) []*ngxNode {
		var nodes []*ngxNode
		var words []string
		for pos < len(toks) {
			t := toks[pos]
			pos++
			switch t {
			case ";":
				if len(words) > 0 {
					nodes = append(nodes, &ngxNode{name: words[0], args: words[1:]})
				}
				words = nil
			case "{":
				n := &ngxNode{}
				if len(words) > 0 {
					n.name, n.args = words[0], words[1:]
				}
				if depth < 12 {
					n.kids = block(depth + 1)
				} else {
					return nodes
				}
				nodes = append(nodes, n)
				words = nil
			case "}":
				return nodes
			default:
				words = append(words, strings.TrimPrefix(t, "\x00"))
			}
		}
		return nodes
	}
	return block(0)
}

func walkNgx(nodes []*ngxNode, fn func(*ngxNode)) {
	for _, n := range nodes {
		fn(n)
		walkNgx(n.kids, fn)
	}
}

func nginxSites(text string) []Site {
	tree := parseNginx(text)
	upstreams := map[string]int{}
	walkNgx(tree, func(n *ngxNode) {
		if n.name == "upstream" && len(n.args) == 1 {
			for _, k := range n.kids {
				if k.name == "server" && len(k.args) > 0 {
					if p := portOf(k.args[0]); p > 0 {
						upstreams[n.args[0]] = p
						break
					}
				}
			}
		}
	})
	var sites []Site
	walkNgx(tree, func(n *ngxNode) {
		if n.name != "server" || len(n.args) != 0 {
			return
		}
		s := Site{Server: "nginx", Kind: "other"}
		var proxy string
		walkNgx(n.kids, func(d *ngxNode) {
			switch d.name {
			case "server_name":
				s.Names = append(s.Names, d.args...)
			case "listen":
				for _, a := range d.args {
					if a == "ssl" {
						s.SSL = true
					}
					if m := listenPortR.FindStringSubmatch(a); m != nil && m[1] == "443" {
						s.SSL = true
					}
				}
			case "ssl_certificate":
				s.SSL = true
			case "root":
				if s.Root == "" && len(d.args) > 0 {
					s.Root = clean(d.args[0], 200)
				}
			case "fastcgi_pass":
				if s.Kind != "php" && len(d.args) > 0 {
					s.Kind = "php"
					if m := phpVerRe.FindStringSubmatch(d.args[0]); m != nil {
						s.PHP = m[1]
					}
				}
			case "proxy_pass":
				if proxy == "" && len(d.args) > 0 {
					proxy = d.args[0]
				}
			}
		})
		if s.Kind != "php" {
			switch {
			case proxy != "":
				s.Kind = "proxy"
				s.Port = proxyPort(proxy, upstreams)
			case s.Root != "":
				s.Kind = "static"
			}
		}
		sites = append(sites, s)
	})
	return sites
}

// proxyPort extracts the local port a proxy_pass targets: `http://127.0.0.1:3000/x`, `http://localhost:3000`, or a
// named upstream. 0 when it is a unix socket or an external host without an explicit port.
func proxyPort(target string, upstreams map[string]int) int {
	t := strings.TrimPrefix(strings.TrimPrefix(target, "http://"), "https://")
	t = strings.SplitN(t, "/", 2)[0]
	if p, ok := upstreams[t]; ok {
		return p
	}
	return portOf(t)
}

func portOf(hostport string) int {
	if strings.HasPrefix(hostport, "unix:") {
		return 0
	}
	i := strings.LastIndex(hostport, ":")
	if i < 0 {
		return 0
	}
	return validPort(strings.TrimRight(hostport[i+1:], ";"))
}

// ── apache ─────────────────────────────────────────────────────────────────────────────────────────────────────────

func apacheSites(text string) []Site {
	var sites []Site
	var cur *Site
	var proxy string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		low := strings.ToLower(line)
		switch {
		case strings.HasPrefix(low, "<virtualhost"):
			cur = &Site{Server: "apache", Kind: "other"}
			proxy = ""
			if strings.Contains(low, ":443") {
				cur.SSL = true
			}
		case strings.HasPrefix(low, "</virtualhost"):
			if cur != nil {
				if cur.Kind != "php" {
					switch {
					case proxy != "":
						cur.Kind, cur.Port = "proxy", proxyPort(proxy, nil)
					case cur.Root != "":
						cur.Kind = "static"
					}
				}
				sites = append(sites, *cur)
			}
			cur = nil
		case cur != nil:
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			arg := strings.Trim(f[1], `"'`)
			switch strings.ToLower(f[0]) {
			case "servername":
				cur.Names = append(cur.Names, arg)
			case "serveralias":
				for _, a := range f[1:] {
					cur.Names = append(cur.Names, strings.Trim(a, `"'`))
				}
			case "documentroot":
				cur.Root = clean(arg, 200)
			case "sslengine":
				if strings.EqualFold(arg, "on") {
					cur.SSL = true
				}
			case "proxypass":
				// `ProxyPass / http://127.0.0.1:3000/` (the target is the last argument); `ProxyPass "/.well-known/" !` is an exemption.
				if last := strings.Trim(f[len(f)-1], `"'`); strings.Contains(last, "://") && proxy == "" {
					proxy = last
				}
			case "sethandler", "addhandler":
				if strings.Contains(strings.ToLower(line), "php") || strings.Contains(strings.ToLower(line), "fcgi") {
					cur.Kind = "php"
					if m := phpVerRe.FindStringSubmatch(strings.ToLower(line)); m != nil {
						cur.PHP = m[1]
					}
				}
			}
		}
	}
	return sites
}
