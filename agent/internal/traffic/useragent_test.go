package traffic

import (
	"strings"
	"testing"
)

func TestParseUserAgent(t *testing.T) {
	cases := []struct {
		name, ua            string
		browser, os, device string
		bot                 bool
	}{
		{"chrome win", uaChromeWin, "Chrome", "Windows", "desktop", false},
		{"firefox linux", uaFirefoxLin, "Firefox", "Linux", "desktop", false},
		{"safari mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15", "Safari", "macOS", "desktop", false},
		{"safari iphone", uaSafariIOS, "Safari", "iOS", "mobile", false},
		{"safari ipad", uaIPad, "Safari", "iOS", "tablet", false},
		{"edge win", uaEdgeWin, "Edge", "Windows", "desktop", false},
		{"edge android", "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0", "Edge", "Android", "mobile", false},
		{"opr", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/105.0.0.0", "Opera", "Windows", "desktop", false},
		{"presto opera", "Opera/9.80 (Windows NT 6.1; U; en) Presto/2.9.168 Version/11.50", "Opera", "Windows", "desktop", false},
		{"samsung", "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36", "Samsung Browser", "Android", "mobile", false},
		{"android chrome mobile", "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36", "Chrome", "Android", "mobile", false},
		{"android tablet", "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Chrome", "Android", "tablet", false},
		{"android stock", "Mozilla/5.0 (Linux; Android 4.4.2; GT-I9505) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30", "Android Browser", "Android", "mobile", false},
		{"chrome ios", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1", "Chrome", "iOS", "mobile", false},
		{"firefox ios", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15", "Firefox", "iOS", "mobile", false},
		{"chromeos", "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Chrome", "ChromeOS", "desktop", false},
		{"ie11", "Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko", "Internet Explorer", "Windows", "desktop", false},
		{"msie", "Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)", "Internet Explorer", "Windows", "desktop", false},
		{"facebook app", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]", "Facebook App", "iOS", "mobile", false},
		{"instagram app", "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 300.0", "Instagram App", "Android", "mobile", false},
		{"freebsd firefox", "Mozilla/5.0 (X11; FreeBSD amd64; rv:120.0) Gecko/20100101 Firefox/120.0", "Firefox", "FreeBSD", "desktop", false},
		{"windows phone", "Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15254", "Edge", "Windows Phone", "mobile", false},
		{"cubot phone is not a bot", "Mozilla/5.0 (Linux; Android 11; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36", "Chrome", "Android", "mobile", false},
		{"unknown mozilla", "Mozilla/5.0", labelOther, labelOther, deviceOther, false},
		// bots
		{"googlebot", uaGooglebot, "Googlebot", "Other", "bot", true},
		{"googlebot mobile", "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot", "Android", "bot", true},
		{"bingbot", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Bingbot", "Other", "bot", true},
		{"adsbot", "Mozilla/5.0 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)", "Google Ads Bot", "Other", "bot", true},
		{"facebook crawler", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "Facebook Crawler", "Other", "bot", true},
		{"unknown bot -> Other", "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", "Other", "Other", "bot", true},
		{"spider", "Mozilla/5.0 (compatible; SomeSpider/1.0)", "Other", "Other", "bot", true},
		{"slurp", "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)", "Other", "Other", "bot", true},
		{"headless chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36", "Headless Chrome", "Windows", "bot", true},
		{"lighthouse", "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Lighthouse", "Chrome", "Windows", "bot", true},
		{"curl", "curl/8.4.0", "Other", "Other", "bot", true},
		{"wget", "Wget/1.21", "Other", "Other", "bot", true},
		{"python-requests", "python-requests/2.31.0", "Other", "Other", "bot", true},
		{"uptime", "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)", "Other", "Other", "bot", true},
		{"monitor", "Mozilla/5.0 (compatible; SiteMonitor/1.0)", "Other", "Other", "bot", true},
		{"yandex images", "Mozilla/5.0 (compatible; YandexImages/3.0; +http://yandex.com/bots)", "Other", "Other", "bot", true},
		{"googleother", "Mozilla/5.0 (compatible; GoogleOther)", "Other", "Other", "bot", true},
		{"google-extended", "Mozilla/5.0 (compatible; Google-Extended)", "Other", "Other", "bot", true},
		{"embedly", "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)", "Other", "Other", "bot", true},
		{"bingpreview", "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0; BingPreview/1.0b)", "Internet Explorer", "Windows", "bot", true},
		{"compatible, nothing known", "Mozilla/4.0 (compatible; Foo 1.2)", "Other", "Other", "bot", true},
		{"old IE stays human", "Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)", "Internet Explorer", "Windows", "desktop", false},
		{"empty", "", "Other", "Other", "bot", true},
		{"whitespace", "   ", "Other", "Other", "bot", true},
	}
	for _, c := range cases {
		got := parseUserAgent(c.ua)
		bot := got.IsBot || isAutomatedUA(c.ua)
		dev := got.DeviceClass
		if bot {
			dev = "bot"
		}
		if got.Browser != c.browser || got.OS != c.os || dev != c.device || bot != c.bot {
			t.Errorf("%s: parseUserAgent = %q %q %q bot=%v, want %q %q %q bot=%v",
				c.name, got.Browser, got.OS, dev, bot, c.browser, c.os, c.device, c.bot)
		}
		// classifyUA is the call site the parser feeds: it must agree.
		b, o, d, cb := classifyUA(c.ua)
		if b != c.browser || o != c.os || d != c.device || cb != c.bot {
			t.Errorf("%s: classifyUA = %q %q %q bot=%v", c.name, b, o, d, cb)
		}
	}
}

func TestParseUserAgentOutputIsClosedSet(t *testing.T) {
	browsers := map[string]bool{}
	for _, t := range append(append([]uaToken{}, uaKnownBots...), uaBrowsers...) {
		browsers[t.label] = true
	}
	for _, l := range []string{labelOther, "Safari", "Android Browser"} {
		browsers[l] = true
	}
	oses := map[string]bool{labelOther: true, "Windows": true, "Windows Phone": true, "Android": true, "macOS": true, "iOS": true,
		"Linux": true, "FreeBSD": true, "ChromeOS": true, "BlackBerry": true, "HarmonyOS": true}
	devices := map[string]bool{"desktop": true, "mobile": true, "tablet": true, "bot": true, deviceOther: true}
	for _, ua := range []string{uaChromeWin, uaIPad, uaGooglebot, "MyWeirdClient-SECRETABC", "SECRET/1.0 (SECRET; SECRET) SECRET",
		"Mozilla/5.0 (SECRET-OS) SECRET-Browser/9", "", "\x00\xff\xfe", strings.Repeat("A/1 ", 5000)} {
		p := parseUserAgent(ua)
		if !browsers[p.Browser] || !oses[p.OS] || !devices[p.DeviceClass] {
			t.Errorf("%.30q -> out-of-set labels %+v", ua, p)
		}
		if strings.Contains(p.Browser+p.OS+p.DeviceClass, "SECRET") {
			t.Errorf("UA text leaked: %+v", p)
		}
	}
}

func TestHasBotWord(t *testing.T) {
	for in, want := range map[string]bool{
		"googlebot/2.1": true, "bot": true, "a bot;": true, "x-bot)": true, "bot/1.0": true,
		"robotics": false, "botanical": false, "cubot_x30": false, "abbott": false, "": false, "cubot bot": true,
	} {
		if got := hasBotWord(in); got != want {
			t.Errorf("hasBotWord(%q) = %v want %v", in, got, want)
		}
	}
}
