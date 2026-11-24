package hostinfo

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProviderFromDMI(t *testing.T) {
	cases := []struct {
		name   string
		fields map[string]string
		want   string
	}{
		{"hetzner", map[string]string{"sys_vendor": "Hetzner", "product_name": "vServer"}, "hetzner"},
		{"digitalocean", map[string]string{"sys_vendor": "DigitalOcean", "product_name": "Droplet"}, "digitalocean"},
		{"vultr", map[string]string{"sys_vendor": "Vultr", "product_name": "VPS"}, "vultr"},
		{"aws", map[string]string{"sys_vendor": "Amazon EC2", "product_name": "t3.small"}, "aws"},
		{"gcp", map[string]string{"sys_vendor": "Google", "product_name": "Google Compute Engine"}, "gcp"},
		{"oracle", map[string]string{"sys_vendor": "QEMU", "chassis_asset_tag": "OracleCloud.com"}, "oracle"},
		{"azure", map[string]string{"sys_vendor": "Microsoft Corporation", "product_name": "Virtual Machine"}, "azure"},
		{"bare metal", map[string]string{"sys_vendor": "Dell Inc.", "product_name": "PowerEdge R640"}, ""},
		{"plain qemu", map[string]string{"sys_vendor": "QEMU", "product_name": "Standard PC"}, ""},
		{"empty", map[string]string{}, ""},
	}
	for _, c := range cases {
		if got := providerFromDMI(c.fields); got != c.want {
			t.Errorf("%s: providerFromDMI=%q want %q", c.name, got, c.want)
		}
	}
}

func TestDMIProviderReadsDir(t *testing.T) {
	dir := t.TempDir()
	old := dmiDir
	dmiDir = dir
	defer func() { dmiDir = old }()
	if got := DMIProvider(); got != "" {
		t.Fatalf("empty dir: got %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "sys_vendor"), []byte("Hetzner\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := DMIProvider(); got != "hetzner" {
		t.Fatalf("got %q want hetzner", got)
	}
	dmiDir = filepath.Join(dir, "missing")
	if got := DMIProvider(); got != "" {
		t.Fatalf("missing dir: got %q", got)
	}
}
