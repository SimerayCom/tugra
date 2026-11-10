package traffic

import "strings"

// A small in-house User-Agent parser. It maps a UA string to a few coarse, whitelisted labels using plain
// substring matching; it never echoes any part of the input, so an unknown client is simply "Other".

// uaInfo is the parse result: Browser and OS are whitelisted labels ("Other" when unknown), DeviceClass is one
// of desktop|mobile|tablet|bot|other.
type uaInfo struct {
	Browser     string
	OS          string
	DeviceClass string
	IsBot       bool
}

// uaTokens maps a lowercase UA substring to a label; the first matching entry wins, so order matters
// (specific products before the engines they embed: Edge/Opera/Samsung all also say "Chrome" and "Safari").
type uaToken struct{ token, label string }

// Named crawlers that carry a stable product label.
var uaKnownBots = []uaToken{
	{"adsbot-google", "Google Ads Bot"},
	{"googlebot", "Googlebot"},
	{"bingbot", "Bingbot"},
	{"applebot", "Applebot"},
	{"yandexadnet", "YandexAdNet"},
	{"yandexbot", "YandexBot"},
	{"twitterbot", "Twitterbot"},
	{"facebookexternalhit", "Facebook Crawler"},
	{"facebot", "Facebook Crawler"},
	{"bytespider", "Bytespider"},
}

var uaBrowsers = []uaToken{
	{"headlesschrome", "Headless Chrome"},
	{"fban", "Facebook App"}, {"fbav", "Facebook App"}, {"fb_iab", "Facebook App"},
	{"instagram", "Instagram App"},
	{"musical_ly", "TikTok App"}, {"tiktok", "TikTok App"}, {"bytedancewebview", "TikTok App"},
	{"edg/", "Edge"}, {"edga/", "Edge"}, {"edgios/", "Edge"}, {"edge/", "Edge"},
	{"opera mini", "Opera Mini"}, {"opt/", "Opera Touch"}, {"opr/", "Opera"}, {"opera", "Opera"},
	{"vivaldi/", "Vivaldi"},
	{"samsungbrowser/", "Samsung Browser"},
	{"miuibrowser/", "Miui Browser"},
	{"huaweibrowser/", "Huawei Browser"},
	{"msie ", "Internet Explorer"}, {"trident/", "Internet Explorer"},
	{"firefox/", "Firefox"}, {"fxios/", "Firefox"},
	{"chrome/", "Chrome"}, {"crios/", "Chrome"},
	{"blackberry", "BlackBerry"}, {"bb10", "BlackBerry"},
	{"netfront", "NetFront"},
}

// Tokens that mark a non-human client. "bot" gets a word-boundary check (see hasBotWord).
var uaBotTokens = []string{
	"spider", "crawl", "slurp", "headless", "monitor", "uptime", "curl", "wget", "python-requests",
	"scrapy", "lighthouse", "pagespeed", "gtmetrix", "mediapartners-google", "google-inspectiontool",
	"ia_archiver", "facebookexternalhit", "facebot", "bytespider",
	// Crawlers that say "Mozilla/5.0 (compatible; X)" with no bot/spider/crawl word, plus the "+http(s)://"
	// contact-URL convention that crawlers use and browsers never do.
	"bingpreview", "yandex.com/bots", "yandeximages", "googleother", "google-extended", "google-favicon",
	"google-read-aloud", "googleproducer", "feedfetcher", "duplexweb-google", "storebot-google", "embedly",
	"+http:", "+https:",
}

// parseUserAgent classifies ua. The caller bounds the length.
func parseUserAgent(ua string) uaInfo {
	l := strings.ToLower(strings.TrimSpace(ua))
	info := uaInfo{Browser: labelOther, OS: labelOther, DeviceClass: deviceOther}

	for _, t := range uaKnownBots {
		if strings.Contains(l, t.token) {
			info.Browser = t.label
			break
		}
	}
	info.IsBot = l == "" || info.Browser != labelOther || hasBotWord(l)
	if !info.IsBot {
		for _, t := range uaBotTokens {
			if strings.Contains(l, t) {
				info.IsBot = true
				break
			}
		}
	}

	info.OS = uaOS(l)
	if info.Browser == labelOther {
		info.Browser = uaBrowser(l, info.OS)
	}
	// "Mozilla/5.0 (compatible; X)" with no recognisable browser or OS is a crawler that names only itself;
	// real clients that use this form (old IE) resolve to a browser and an OS.
	if !info.IsBot && strings.Contains(l, "(compatible;") && info.Browser == labelOther && info.OS == labelOther {
		info.IsBot = true
	}

	switch {
	case info.IsBot:
		info.DeviceClass = "bot"
	case uaIsTablet(l, info.OS):
		info.DeviceClass = "tablet"
	case uaIsMobile(l, info.OS):
		info.DeviceClass = "mobile"
	case info.OS == "Windows" || info.OS == "macOS" || info.OS == "Linux" || info.OS == "ChromeOS" || info.OS == "FreeBSD",
		info.OS == labelOther && info.Browser != labelOther:
		info.DeviceClass = "desktop"
	}
	return info
}

func uaBrowser(l, os string) string {
	for _, t := range uaBrowsers {
		if strings.Contains(l, t.token) {
			return t.label
		}
	}
	// The stock Android browser: "Android ... Version/x ... Safari/x" and no Chrome token.
	if os == "Android" && strings.Contains(l, "version/") && strings.Contains(l, "safari/") {
		return "Android Browser"
	}
	if strings.Contains(l, "safari/") {
		return "Safari"
	}
	return labelOther
}

func uaOS(l string) string {
	switch {
	case strings.Contains(l, "windows phone"):
		return "Windows Phone"
	case strings.Contains(l, "android"):
		return "Android"
	case strings.Contains(l, "cros "): // "CrOS x86_64 ..."
		return "ChromeOS"
	case strings.Contains(l, "iphone"), strings.Contains(l, "ipad"), strings.Contains(l, "ipod"):
		return "iOS" // before macOS: iOS UAs say "like Mac OS X"
	case strings.Contains(l, "harmonyos"):
		return "HarmonyOS"
	case strings.Contains(l, "macintosh"), strings.Contains(l, "mac os x"):
		return "macOS"
	case strings.Contains(l, "windows"):
		return "Windows"
	case strings.Contains(l, "blackberry"), strings.Contains(l, "bb10"):
		return "BlackBerry"
	case strings.Contains(l, "freebsd"):
		return "FreeBSD"
	case strings.Contains(l, "linux"), strings.Contains(l, "x11"):
		return "Linux"
	}
	return labelOther
}

func uaIsTablet(l, os string) bool {
	if strings.Contains(l, "ipad") || strings.Contains(l, "tablet") || strings.Contains(l, "kindle") || strings.Contains(l, "silk/") {
		return true
	}
	// Android phones say "Mobile"; an Android UA without it is a tablet.
	return os == "Android" && !strings.Contains(l, "mobile")
}

func uaIsMobile(l, os string) bool {
	if os == "iOS" || os == "Windows Phone" || os == "BlackBerry" || os == "Android" {
		return true
	}
	return strings.Contains(l, "mobile") || strings.Contains(l, "opera mini")
}

// hasBotWord reports whether l contains "bot" as a name suffix (Googlebot, "bot/1.0", "bot;") rather than
// inside a longer word ("robotics", "botanical") or a phone model ("Cubot").
func hasBotWord(l string) bool {
	for from := 0; ; {
		i := strings.Index(l[from:], "bot")
		if i < 0 {
			return false
		}
		i += from
		end := i + 3
		afterLetter := end < len(l) && l[end] >= 'a' && l[end] <= 'z'
		cubot := i >= 2 && l[i-2:i] == "cu"
		if !afterLetter && !cubot {
			return true
		}
		from = end
	}
}
