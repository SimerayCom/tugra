package hostinfo

import (
	"os"
	"path/filepath"
	"strings"
)

// dmiDir is the kernel's read-only DMI (SMBIOS) vendor strings; overridable in tests.
var dmiDir = "/sys/class/dmi/id"

// dmiFiles are the world-readable identity strings used to recognise a cloud provider. Serial numbers and UUIDs are
// never read.
var dmiFiles = []string{"sys_vendor", "product_name", "board_vendor", "chassis_asset_tag"}

// providerFromDMI maps the DMI vendor strings to a provider slug, or "" when nothing recognisable is there. The
// strings are untrusted text from the hypervisor: only a fixed set of slugs can come out. Pure.
func providerFromDMI(fields map[string]string) string {
	all := strings.ToLower(strings.Join([]string{fields["sys_vendor"], fields["product_name"], fields["board_vendor"], fields["chassis_asset_tag"]}, "|"))
	has := func(s string) bool { return strings.Contains(all, s) }
	switch {
	case has("hetzner"):
		return "hetzner"
	case has("digitalocean"):
		return "digitalocean"
	case has("vultr"):
		return "vultr"
	case has("amazon ec2") || has("amazon"):
		return "aws"
	case has("google compute engine") || has("google"):
		return "gcp"
	case has("oraclecloud"):
		return "oracle"
	case has("microsoft") && has("virtual machine"):
		return "azure"
	case has("ovh"):
		return "ovh"
	case has("contabo"):
		return "contabo"
	case has("linode") || has("akamai"):
		return "linode"
	case has("scaleway"):
		return "scaleway"
	case has("upcloud"):
		return "upcloud"
	case has("netcup"):
		return "netcup"
	case has("ionos"):
		return "ionos"
	}
	return ""
}

// DMIProvider reads the DMI vendor strings and returns the provider slug they name ("" off-cloud, on bare metal or
// when /sys is not readable). Best-effort and read-only: it never leaves the machine.
func DMIProvider() string {
	fields := map[string]string{}
	for _, f := range dmiFiles {
		b, err := os.ReadFile(filepath.Join(dmiDir, f))
		if err != nil {
			continue
		}
		if len(b) > 256 {
			b = b[:256]
		}
		fields[f] = strings.TrimSpace(string(b))
	}
	return providerFromDMI(fields)
}
