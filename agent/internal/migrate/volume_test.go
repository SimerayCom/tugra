package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

const (
	appCtrID = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	dbCtrID  = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	thirdID  = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
)

// vctr is a fake source container with mounts and a state.
type vctr struct {
	id, name, image string
	running         bool
	exit            int
	started, finish string
	mounts          []dockerMount
}

// volDocker stubs runDocker for the volume arm: ps -a, inspect, `ps -q --filter volume=`, helper runs and stop/start.
type volDocker struct {
	mu          sync.Mutex
	ctrs        []*vctr
	users       map[string][]string // volume/path -> running container ids using it (ps -q --filter volume=)
	invOut      string              // what the inventory helper prints
	runCalls    [][]string
	stopCalls   [][]string
	startCalls  [][]string
	runErr      error
	stopErr     error
	onStop      func(c *vctr)
	psAllCalled bool
}

func (d *volDocker) install(t *testing.T) {
	t.Helper()
	orig := runDocker
	t.Cleanup(func() { runDocker = orig })
	runDocker = func(ctx context.Context, argv []string, env []string) ([]byte, string, error) {
		d.mu.Lock()
		defer d.mu.Unlock()
		if len(argv) < 2 {
			return nil, "", fmt.Errorf("short argv")
		}
		switch argv[1] {
		case "ps":
			if contains(argv, "-q") {
				var out []string
				for _, a := range argv {
					if v, ok := strings.CutPrefix(a, "volume="); ok {
						out = append(out, d.users[v]...)
					}
				}
				return []byte(strings.Join(out, "\n")), "", nil
			}
			d.psAllCalled = d.psAllCalled || contains(argv, "-a")
			var b strings.Builder
			for _, c := range d.ctrs {
				b.WriteString(c.id + "\t" + c.name + "\n")
			}
			return []byte(b.String()), "", nil
		case "inspect":
			id := argv[len(argv)-1]
			for _, c := range d.ctrs {
				if c.id == id {
					ms, _ := json.Marshal(c.mounts)
					j := fmt.Sprintf(`{"Id":%q,"Name":"/%s","Image":"sha256:img1","State":{"Running":%v,"Paused":false,"Restarting":false,"ExitCode":%d,"StartedAt":%q,"FinishedAt":%q},"Config":{"Image":%q,"Env":[],"Labels":{}},"Mounts":%s}`,
						c.id, c.name, c.running, c.exit, c.started, c.finish, c.image, ms)
					return []byte(j), "", nil
				}
			}
			return nil, "No such object", fmt.Errorf("exit 1")
		case "run":
			d.runCalls = append(d.runCalls, append([]string{}, argv...))
			if d.runErr != nil {
				return nil, "boom", d.runErr
			}
			return []byte(d.invOut), "", nil
		case "stop":
			d.stopCalls = append(d.stopCalls, append([]string{}, argv...))
			if d.stopErr != nil {
				return nil, "cannot stop", d.stopErr
			}
			id := argv[len(argv)-1]
			for _, c := range d.ctrs {
				if c.id == id {
					c.running = false
					if d.onStop != nil {
						d.onStop(c)
					}
				}
			}
			return nil, "", nil
		case "start":
			d.startCalls = append(d.startCalls, append([]string{}, argv...))
			id := argv[len(argv)-1]
			for _, c := range d.ctrs {
				if c.id == id {
					c.running = true
				}
			}
			return nil, "", nil
		}
		return nil, "", fmt.Errorf("unexpected argv %v", argv)
	}
}

func contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}

func appVolTarget(ref string) Target {
	return Target{ItemRef: "volume:srv1:" + ref + ":data", Kind: "volume", VolumeIngest: "stream-v2", Dest: &VolDest{Type: "app-volume", Name: "data", MountPath: "/var/www/data"}, AppItemRef: "app:srv1:" + ref}
}

func dbVolTarget(ref string) Target {
	return Target{ItemRef: "volume:srv1:" + ref + ":data", Kind: "volume", VolumeIngest: "stream-v2", Dest: &VolDest{Type: "db-data", Name: "data", MountPath: "/var/lib/postgresql/data"},
		DatabaseItemRef: "database:srv1:" + ref, Engine: "POSTGRES", EngineVersion: "16", SourceImage: "postgres:16-alpine"}
}

func stoppedApp() *vctr {
	return &vctr{id: appCtrID, name: "5f3a9c-170000000000", image: "ghcr.io/x/web:1", exit: 0, started: "2026-11-01T00:00:00Z", finish: "2026-11-14T10:00:00Z",
		mounts: []dockerMount{{Type: "volume", Name: "5f3a9c_data", Source: "/var/lib/docker/volumes/5f3a9c_data/_data", Destination: "/var/www/data", RW: true}}}
}

func TestParseVolumeRef(t *testing.T) {
	ok := []struct{ in, srv, src, vol string }{
		{"volume:srv1:5f3a9c:data", "srv1", "5f3a9c", "data"},
		{"volume:_:abc-def_1:wp-content", "_", "abc-def_1", "wp-content"},
	}
	for _, c := range ok {
		s, r, v, err := ParseVolumeRef(c.in)
		if err != nil || s != c.srv || r != c.src || v != c.vol {
			t.Errorf("%q -> %q %q %q %v", c.in, s, r, v, err)
		}
	}
	for _, bad := range []string{"", "volume:a:b", "volume:a:b:c:d", "app:a:b:c", "volume:a:b;x:c", "volume:a:-b:c", "volume:a:b:C", "volume:a:b:../x", "volume::b:c", "volume:a:b:", strings.Repeat("x", 300)} {
		if _, _, _, err := ParseVolumeRef(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestResolveVolumeStoppedContainerViaPsA(t *testing.T) {
	d := &volDocker{ctrs: []*vctr{stoppedApp()}}
	d.install(t)
	vs, err := ResolveVolume(context.Background(), appVolTarget("5f3a9c"), "", "docker", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !d.psAllCalled {
		t.Error("the volume arm must list with `docker ps -a` so a STOPPED container resolves")
	}
	if vs.ContainerID != appCtrID || vs.MountType != "volume" || vs.VolumeName != "5f3a9c_data" || vs.Destination != "/var/www/data" || vs.State.Running {
		t.Errorf("unexpected source %+v", vs)
	}
	if vs.State.FinishedAt != "2026-11-14T10:00:00Z" || vs.Image != "ghcr.io/x/web:1" || vs.ImageID != "sha256:img1" {
		t.Errorf("state/image not carried: %+v", vs)
	}
}

func TestResolveVolumeMountMatching(t *testing.T) {
	c := stoppedApp()
	c.mounts = append(c.mounts, dockerMount{Type: "bind", Source: "/srv/media", Destination: "/media"})
	d := &volDocker{ctrs: []*vctr{c}}
	d.install(t)
	// trailing slash and double slashes canonicalise
	tg := appVolTarget("5f3a9c")
	tg.Dest.MountPath = "/var/www//data/"
	if _, err := ResolveVolume(context.Background(), tg, "", "docker", nil); err != nil {
		t.Errorf("canonical mount path should match: %v", err)
	}
	// bind
	tg.Dest.MountPath = "/media"
	vs, err := ResolveVolume(context.Background(), tg, "", "docker", nil)
	if err != nil || vs.MountType != "bind" || vs.HostPath != "/srv/media" {
		t.Errorf("bind: %+v %v", vs, err)
	}
	// destination absent
	tg.Dest.MountPath = "/nope"
	if _, err := ResolveVolume(context.Background(), tg, "", "docker", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("absent destination: %v", err)
	}
}

func TestResolveVolumeRefusals(t *testing.T) {
	t.Run("ambiguous: two containers named <ref>-<digits>", func(t *testing.T) {
		a, b := stoppedApp(), stoppedApp()
		b.id, b.name = otherID, "5f3a9c-170000000001"
		(&volDocker{ctrs: []*vctr{a, b}}).install(t)
		if _, err := ResolveVolume(context.Background(), appVolTarget("5f3a9c"), "", "docker", nil); !errors.Is(err, ErrAmbiguous) {
			t.Errorf("want ErrAmbiguous, got %v", err)
		}
	})
	t.Run("not found", func(t *testing.T) {
		(&volDocker{ctrs: []*vctr{stoppedApp()}}).install(t)
		if _, err := ResolveVolume(context.Background(), appVolTarget("zzzzzz"), "", "docker", nil); !errors.Is(err, ErrNotFound) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("control-plane names are forbidden", func(t *testing.T) {
		for _, n := range []string{"coolify-db", "tugra_db_x", "tugra-fsd-1"} {
			c := stoppedApp()
			c.name = n
			(&volDocker{ctrs: []*vctr{c}}).install(t)
			tg := appVolTarget("5f3a9c")
			if _, err := ResolveVolume(context.Background(), tg, n, "docker", nil); !errors.Is(err, ErrForbidden) {
				t.Errorf("%s: got %v", n, err)
			}
		}
	})
	t.Run("a tmpfs mount is refused", func(t *testing.T) {
		c := stoppedApp()
		c.mounts = []dockerMount{{Type: "tmpfs", Destination: "/var/www/data"}}
		(&volDocker{ctrs: []*vctr{c}}).install(t)
		if _, err := ResolveVolume(context.Background(), appVolTarget("5f3a9c"), "", "docker", nil); !errors.Is(err, ErrBadMount) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("not a volume row", func(t *testing.T) {
		if _, err := ResolveVolume(context.Background(), Target{Kind: "database"}, "", "docker", nil); !errors.Is(err, ErrNotFound) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("--map override is exact name or id", func(t *testing.T) {
		(&volDocker{ctrs: []*vctr{stoppedApp()}}).install(t)
		vs, err := ResolveVolume(context.Background(), appVolTarget("whatever"), appCtrID, "docker", nil)
		if err != nil || vs.ContainerID != appCtrID {
			t.Errorf("override by id: %+v %v", vs, err)
		}
	})
}

func TestResolveVolumeDBDataAcceptsPG18ParentMount(t *testing.T) {
	pg := &vctr{id: dbCtrID, name: "pg7c1", image: "postgres:18-alpine", mounts: []dockerMount{{Type: "volume", Name: "pg_data", Destination: "/var/lib/postgresql"}}}
	(&volDocker{ctrs: []*vctr{pg}}).install(t)
	vs, err := ResolveVolume(context.Background(), dbVolTarget("pg7c1"), "", "docker", nil)
	if err != nil || vs.Destination != "/var/lib/postgresql" {
		t.Fatalf("the PG18 parent mount must resolve so the layout gate can refuse it with its own reason: %+v %v", vs, err)
	}
	// ...but an app volume never matches it
	pg.mounts[0].Destination = "/var/lib/postgresql"
	if _, err := ResolveVolume(context.Background(), appVolTarget("pg7c1"), "", "docker", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("app-volume must not accept the pg parent mount: %v", err)
	}
	// db rows use the exact name only (no -digits suffix)
	pg.name = "pg7c1-170000000000"
	if _, err := ResolveVolume(context.Background(), dbVolTarget("pg7c1"), "", "docker", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("db-data must be an exact name match: %v", err)
	}
}

func TestCheckBindPath(t *testing.T) {
	ok := []string{"/srv/media", "/data/coolify/applications/abc/uploads", "/mnt/disk1/x_y-z.1"}
	for _, p := range ok {
		if err := CheckBindPath(p); err != nil {
			t.Errorf("%s should pass: %v", p, err)
		}
	}
	bad := []string{"/", "/etc", "/etc/passwd.d", "/proc/1", "/sys", "/dev/sda", "/run/x", "/var/run/docker.sock", "/var/lib/docker/volumes/x", "/root/.ssh", "/boot", "/data/coolify/ssh/keys", "/data/coolify/proxy", "/srv/app.sock",
		"relative/path", "/srv//x", "/srv/../etc", "/srv/a b", "/srv/a:b", "/srv/a,b", "/srv/$(x)", "", "/home", "/usr", "/var"}
	for _, p := range bad {
		if err := CheckBindPath(p); err == nil {
			t.Errorf("%q must be refused", p)
		}
	}
	// a symlink that escapes into a denied location is refused when it is resolvable here (Linux: /etc is a real dir)
	if runtime.GOOS != "linux" {
		return
	}
	dir := t.TempDir()
	link := filepath.Join(dir, "evil")
	if err := os.Symlink("/etc", link); err == nil {
		if err := CheckBindPath(link); err == nil {
			t.Errorf("a symlink to /etc must be refused")
		}
	}
}

func TestVerifyQuiescent(t *testing.T) {
	src := &volSource{ContainerID: appCtrID, Name: "web", MountType: "volume", VolumeName: "5f3a9c_data"}
	d := &volDocker{users: map[string][]string{}}
	d.install(t)
	if err := VerifyQuiescent(context.Background(), "docker", nil, src); err != nil {
		t.Errorf("stopped + nobody else: %v", err)
	}
	for name, st := range map[string]srcState{"running": {Running: true}, "restarting": {Restarting: true}, "paused": {Paused: true}} {
		s2 := *src
		s2.State = st
		err := VerifyQuiescent(context.Background(), "docker", nil, &s2)
		if !errors.Is(err, ErrSourceRunning) || !strings.Contains(err.Error(), "stop web first") {
			t.Errorf("%s: %v", name, err)
		}
	}
	d.users["5f3a9c_data"] = []string{thirdID}
	if err := VerifyQuiescent(context.Background(), "docker", nil, src); !errors.Is(err, ErrSourceRunning) {
		t.Errorf("another running container on the same volume: %v", err)
	}
	d.users["5f3a9c_data"] = []string{appCtrID} // only ourselves (stale listing): not "another"
	if err := VerifyQuiescent(context.Background(), "docker", nil, src); err != nil {
		t.Errorf("only the source itself: %v", err)
	}
	d.users["5f3a9c_data"] = []string{"garbage"}
	if err := VerifyQuiescent(context.Background(), "docker", nil, src); err == nil {
		t.Error("unparseable ps output must fail closed")
	}
	// bind: filtered by host path
	b := &volSource{ContainerID: appCtrID, Name: "web", MountType: "bind", HostPath: "/srv/media"}
	d.users["/srv/media"] = []string{thirdID}
	if err := VerifyQuiescent(context.Background(), "docker", nil, b); !errors.Is(err, ErrSourceRunning) {
		t.Errorf("bind users: %v", err)
	}
}

func TestParseInventory(t *testing.T) {
	good := "noise\nTUGRA_INV bytes=1000 entries=12 sockets=1 fifos=2 devices=0 pgv=16 nested=-\n"
	inv, err := parseInventory(good)
	if err != nil || inv.RawBytes != 1000 || inv.Entries != 12 || inv.Sockets != 1 || inv.Fifos != 2 || inv.PgMajor != "16" || inv.PgLayout != "root" {
		t.Errorf("good: %+v %v", inv, err)
	}
	inv, _ = parseInventory("TUGRA_INV bytes=1 entries=1 sockets=0 fifos=0 devices=0 pgv=- nested=18\n")
	if inv.PgMajor != "18" || inv.PgLayout != "nested" {
		t.Errorf("nested layout: %+v", inv)
	}
	inv, _ = parseInventory("TUGRA_INV bytes=1 entries=1 sockets=0 fifos=0 devices=0 pgv=- nested=-\n")
	if inv.PgLayout != "none" || inv.PgMajor != "" {
		t.Errorf("no pg: %+v", inv)
	}
	for _, bad := range []string{"", "garbage", "TUGRA_INV bytes=x entries=1 sockets=0 fifos=0 devices=0 pgv=- nested=-", "TUGRA_INV bytes=1 entries=1", good + good, "TUGRA_INV bytes=-5 entries=1 sockets=0 fifos=0 devices=0 pgv=- nested=-"} {
		if _, err := parseInventory(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

func TestInventoryVolumeArgvIsHardenedAndNeverPulls(t *testing.T) {
	d := &volDocker{invOut: "TUGRA_INV bytes=5 entries=2 sockets=0 fifos=0 devices=0 pgv=16 nested=-\n"}
	d.install(t)
	src := &volSource{ContainerID: appCtrID, Name: "pg", Image: "postgres:16-alpine", MountType: "volume", VolumeName: "pg_data", Destination: "/var/lib/postgresql/data"}
	inv, err := InventoryVolume(context.Background(), "docker", nil, "ghcr.io/x/tugra-agent:1", src, []string{"postmaster.pid"})
	if err != nil {
		t.Fatal(err)
	}
	if !inv.Found || inv.Image != "postgres:16-alpine" || inv.MountDest != "/var/lib/postgresql/data" || inv.PgMajor != "16" || inv.PgLayout != "root" {
		t.Errorf("inventory: %+v", inv)
	}
	argv := strings.Join(d.runCalls[0], " ")
	for _, want := range []string{"--pull=never", "--network none", "--read-only", "--cap-drop ALL", "--cap-add DAC_READ_SEARCH", "--security-opt no-new-privileges", "--pids-limit 64", "-v pg_data:/data:ro", "--entrypoint sh", "ghcr.io/x/tugra-agent:1", "! -path /data/postmaster.pid"} {
		if !strings.Contains(argv, want) {
			t.Errorf("inventory argv missing %q in: %s", want, argv)
		}
	}
	if strings.Count(argv, "--cap-add") != 1 {
		t.Error("DAC_READ_SEARCH must be the ONLY added capability")
	}
	// no helper image -> refused, nothing run
	d2 := &volDocker{}
	d2.install(t)
	if _, err := InventoryVolume(context.Background(), "docker", nil, "", src, nil); !errors.Is(err, ErrNoHelper) || len(d2.runCalls) != 0 {
		t.Errorf("no helper: %v", err)
	}
	// garbage output / run error fail closed
	d3 := &volDocker{invOut: "nonsense"}
	d3.install(t)
	if _, err := InventoryVolume(context.Background(), "docker", nil, "img", src, nil); err == nil {
		t.Error("garbage inventory must fail closed")
	}
	d4 := &volDocker{runErr: errors.New("exit 1")}
	d4.install(t)
	if _, err := InventoryVolume(context.Background(), "docker", nil, "img", src, nil); err == nil {
		t.Error("a failed helper must fail closed")
	}
	// an unsafe exclude never reaches the script
	d5 := &volDocker{invOut: d.invOut}
	d5.install(t)
	if _, err := InventoryVolume(context.Background(), "docker", nil, "img", src, []string{"x; rm -rf /"}); err == nil || len(d5.runCalls) != 0 {
		t.Error("unsafe exclude must be refused")
	}
}

func svcVolTarget(uuid, vol, mount string) Target {
	return Target{ItemRef: "volume:srv1:" + uuid + ":" + vol, Kind: "volume", VolumeIngest: "stream-v2", Dest: &VolDest{Type: "app-volume", Name: vol, MountPath: mount}, AppItemRef: "service:srv1:" + uuid}
}

func svcMember(id, name, volume, dest string) *vctr {
	return &vctr{id: id, name: name, image: "example.test/search:1", exit: 0, started: "2026-11-01T00:00:00Z", finish: "2026-11-14T10:00:00Z",
		mounts: []dockerMount{{Type: "volume", Name: volume, Source: "/var/lib/docker/volumes/" + volume + "/_data", Destination: dest, RW: true}}}
}

func TestResolveServiceVolumeFindsTheMemberThatMountsThePath(t *testing.T) {
	// a Coolify service: no container carries the bare uuid, the members are `<member>-<uuid>`
	search := svcMember(appCtrID, "search-ab12cd", "ab12cd_search-data", "/data.ms")
	proxy := svcMember(dbCtrID, "proxy-ab12cd", "ab12cd_proxy-conf", "/etc/proxy")
	other := svcMember(thirdID, "search-zz99zz", "zz99zz_search-data", "/data.ms")
	(&volDocker{ctrs: []*vctr{proxy, other, search}}).install(t)
	vs, err := ResolveVolume(context.Background(), svcVolTarget("ab12cd", "search-data", "/data.ms"), "", "docker", nil)
	if err != nil {
		t.Fatal(err)
	}
	if vs.ContainerID != appCtrID || vs.VolumeName != "ab12cd_search-data" || vs.Destination != "/data.ms" {
		t.Errorf("unexpected source %+v", vs)
	}
}

func TestResolveServiceVolumeRefusals(t *testing.T) {
	t.Run("no member mounts the path", func(t *testing.T) {
		(&volDocker{ctrs: []*vctr{svcMember(appCtrID, "search-ab12cd", "ab12cd_search-data", "/data.ms")}}).install(t)
		if _, err := ResolveVolume(context.Background(), svcVolTarget("ab12cd", "search-data", "/elsewhere"), "", "docker", nil); !errors.Is(err, ErrNotFound) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("two members mount the same path: ambiguous", func(t *testing.T) {
		a := svcMember(appCtrID, "one-ab12cd", "ab12cd_a", "/data")
		b := svcMember(dbCtrID, "two-ab12cd", "ab12cd_b", "/data")
		(&volDocker{ctrs: []*vctr{a, b}}).install(t)
		if _, err := ResolveVolume(context.Background(), svcVolTarget("ab12cd", "a", "/data"), "", "docker", nil); !errors.Is(err, ErrAmbiguous) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("no container of that service", func(t *testing.T) {
		(&volDocker{ctrs: []*vctr{svcMember(appCtrID, "search-zz99zz", "zz99zz_d", "/data")}}).install(t)
		if _, err := ResolveVolume(context.Background(), svcVolTarget("ab12cd", "d", "/data"), "", "docker", nil); !errors.Is(err, ErrNotFound) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("an app volume never takes the service fallback", func(t *testing.T) {
		(&volDocker{ctrs: []*vctr{svcMember(appCtrID, "search-ab12cd", "ab12cd_d", "/data")}}).install(t)
		tg := svcVolTarget("ab12cd", "d", "/data")
		tg.AppItemRef = "app:srv1:ab12cd"
		if _, err := ResolveVolume(context.Background(), tg, "", "docker", nil); !errors.Is(err, ErrNotFound) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("a --map override wins over the fallback", func(t *testing.T) {
		a := svcMember(appCtrID, "one-ab12cd", "ab12cd_a", "/data")
		b := svcMember(dbCtrID, "two-ab12cd", "ab12cd_b", "/data")
		(&volDocker{ctrs: []*vctr{a, b}}).install(t)
		vs, err := ResolveVolume(context.Background(), svcVolTarget("ab12cd", "a", "/data"), "two-ab12cd", "docker", nil)
		if err != nil || vs.ContainerID != dbCtrID {
			t.Errorf("override: %+v %v", vs, err)
		}
	})
}
