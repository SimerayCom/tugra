package migrate

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

const (
	pgID    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	otherID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// fakeDocker stubs the runDocker package var. ps returns the given rows; inspect returns the
// matching container's JSON.
type fakeContainer struct {
	id, name, image string
	envv            []string
	running         bool
}

func withFakeDocker(t *testing.T, cs []fakeContainer) {
	t.Helper()
	orig := runDocker
	t.Cleanup(func() { runDocker = orig })
	runDocker = func(ctx context.Context, argv []string, env []string) ([]byte, string, error) {
		if len(argv) >= 2 && argv[1] == "ps" {
			var b strings.Builder
			for _, c := range cs {
				b.WriteString(c.id + "\t" + c.name + "\n")
			}
			return []byte(b.String()), "", nil
		}
		if len(argv) >= 2 && argv[1] == "inspect" {
			id := argv[len(argv)-1]
			for _, c := range cs {
				if c.id == id {
					st := "false"
					if c.running {
						st = "true"
					}
					envJSON := "[]"
					if len(c.envv) > 0 {
						parts := make([]string, len(c.envv))
						for i, e := range c.envv {
							parts[i] = `"` + e + `"`
						}
						envJSON = "[" + strings.Join(parts, ",") + "]"
					}
					j := fmt.Sprintf(`{"Id":%q,"Name":"/%s","Image":"sha256:deadbeef","Path":"docker-entrypoint.sh","Args":[],"State":{"Running":%s},"Config":{"Image":%q,"Env":%s,"Labels":{}}}`,
						c.id, c.name, st, c.image, envJSON)
					return []byte(j), "", nil
				}
			}
			return nil, "No such object", fmt.Errorf("exit 1")
		}
		return nil, "", fmt.Errorf("unexpected argv %v", argv)
	}
}

func dbTarget(ref, engine string) Target {
	return Target{ItemRef: "database:_:" + ref, Kind: "database", Engine: engine}
}

func TestResolveExactNameMatch(t *testing.T) {
	withFakeDocker(t, []fakeContainer{
		{id: pgID, name: "mypg", image: "postgres:16", running: true},
		{id: otherID, name: "other", image: "redis:7", running: true},
	})
	src, err := Resolve(context.Background(), dbTarget("mypg", "POSTGRES"), "", "docker", nil)
	if err != nil {
		t.Fatal(err)
	}
	if src.ID != pgID {
		t.Errorf("resolved to %s, want %s", src.ID, pgID)
	}
}

func TestResolveNoHexPrefixMatch(t *testing.T) {
	// A source ref that is a hex PREFIX of a container ID must NOT match by ID (only exact names).
	withFakeDocker(t, []fakeContainer{{id: pgID, name: "realname", image: "postgres:16", running: true}})
	_, err := Resolve(context.Background(), dbTarget("aaaaaaaaaaaa", "POSTGRES"), "", "docker", nil)
	if err != ErrNotFound {
		t.Errorf("a hex prefix must not auto-match; got %v", err)
	}
}

func TestResolveForbidden(t *testing.T) {
	withFakeDocker(t, []fakeContainer{{id: pgID, name: "tugra_db_x", image: "postgres:16", running: true}})
	if _, err := Resolve(context.Background(), dbTarget("tugra_db_x", "POSTGRES"), "", "docker", nil); err != ErrForbidden {
		t.Errorf("tugra_ container must be forbidden, got %v", err)
	}
}

func TestResolveEngineMismatch(t *testing.T) {
	withFakeDocker(t, []fakeContainer{{id: pgID, name: "mypg", image: "mysql:8", running: true}})
	if _, err := Resolve(context.Background(), dbTarget("mypg", "POSTGRES"), "", "docker", nil); err != ErrEngineMismatch {
		t.Errorf("image/engine mismatch must be refused, got %v", err)
	}
}

func TestResolveNotRunning(t *testing.T) {
	withFakeDocker(t, []fakeContainer{{id: pgID, name: "mypg", image: "postgres:16", running: false}})
	if _, err := Resolve(context.Background(), dbTarget("mypg", "POSTGRES"), "", "docker", nil); err != ErrNotRunning {
		t.Errorf("stopped container must be refused, got %v", err)
	}
}

func TestResolveMapOverride(t *testing.T) {
	// auto-match would fail (name != uuid), but --map points at the right container by name.
	withFakeDocker(t, []fakeContainer{{id: pgID, name: "renamed-pg", image: "postgres:16", running: true}})
	tg := dbTarget("some-uuid", "POSTGRES")
	src, err := Resolve(context.Background(), tg, "renamed-pg", "docker", nil)
	if err != nil {
		t.Fatal(err)
	}
	if src.ID != pgID {
		t.Errorf("map override resolved to %s", src.ID)
	}
	// a map to the wrong engine is still refused
	withFakeDocker(t, []fakeContainer{{id: pgID, name: "renamed-pg", image: "redis:7", running: true}})
	if _, err := Resolve(context.Background(), tg, "renamed-pg", "docker", nil); err != ErrEngineMismatch {
		t.Errorf("map to a wrong-engine container must be refused, got %v", err)
	}
}

func TestParseItemRef(t *testing.T) {
	if _, ref, err := ParseItemRef("database:_:abc-123"); err != nil || ref != "abc-123" {
		t.Errorf("good ref failed: ref=%q err=%v", ref, err)
	}
	bad := []string{"database:_:a:b", "database:_:a.b", "app:_:x", "database:_:", "database:_:-x", "database:_:a b"}
	for _, b := range bad {
		if _, _, err := ParseItemRef(b); err == nil {
			t.Errorf("expected %q to be rejected", b)
		}
	}
}

func TestClassifyEnginePrecedence(t *testing.T) {
	cases := map[string]string{
		"keydb:latest":              "KEYDB",
		"docker.dragonflydb.io/dragonflydb/dragonfly": "DRAGONFLY",
		"mariadb:11":                "MARIADB",
		"postgres:16":               "POSTGRES",
		"mysql:8":                   "MYSQL",
		"redis:7":                   "REDIS",
		"valkey/valkey:9-alpine":    "REDIS",
		"docker.io/valkey/valkey:8": "REDIS",
		"registry.example.com:5000/lib/postgres:16": "POSTGRES",
	}
	for img, want := range cases {
		if got := classifyEngine(img, nil); got != want {
			t.Errorf("classify(%q)=%q want %q", img, got, want)
		}
	}
	// a Valkey image is Redis-compatible by NAME: no REDIS_PASSWORD (or any env) is needed to classify it
	if got := classifyEngine("valkey/valkey:9-alpine", map[string]string{"SOMETHING": "x"}); got != "REDIS" {
		t.Errorf("valkey without env: %q", got)
	}
	// env-signature fallback for an unrecognised image
	if got := classifyEngine("custom/db:1", map[string]string{"POSTGRES_PASSWORD": "x"}); got != "POSTGRES" {
		t.Errorf("env fallback failed: %q", got)
	}
}

func TestResolveBySuffixedNameBothCoolifyForms(t *testing.T) {
	const uuid = "x8kc0sw4cw0c0ooc0o4gg0ck"
	row := func(id, name string) psRow { return psRow{id: id, names: []string{name}} }
	cases := []struct {
		name    string
		rows    []psRow
		ref     string
		want    string
		wantErr error
	}{
		{"legacy digits", []psRow{row(pgID, uuid+"-170000000000")}, uuid, pgID, nil},
		{"4.7.5 ISO timestamp", []psRow{row(pgID, uuid+"-20261110T153012")}, uuid, pgID, nil},
		{"custom prefix, ISO", []psRow{row(pgID, "shop-20261110T153012")}, "shop", pgID, nil},
		{"custom prefix, legacy", []psRow{row(pgID, "shop-170000000000")}, "shop", pgID, nil},
		{"old and new deploy are ambiguous", []psRow{row(pgID, uuid+"-170000000000"), row(otherID, uuid+"-20261110T153012")}, uuid, "", ErrAmbiguous},
		{"preview container is not the app", []psRow{row(pgID, uuid+"-pr-12")}, uuid, "", ErrNotFound},
		{"short digits", []psRow{row(pgID, uuid+"-12345")}, uuid, "", ErrNotFound},
		{"ISO with lowercase t", []psRow{row(pgID, uuid+"-20261110t153012")}, uuid, "", ErrNotFound},
		{"ISO too short", []psRow{row(pgID, uuid+"-20261110T1530")}, uuid, "", ErrNotFound},
		{"ISO with trailing junk", []psRow{row(pgID, uuid+"-20261110T153012x")}, uuid, "", ErrNotFound},
		{"ISO with a second suffix", []psRow{row(pgID, uuid+"-20261110T153012-1")}, uuid, "", ErrNotFound},
		{"another uuid sharing the prefix", []psRow{row(pgID, uuid+"x-20261110T153012")}, uuid, "", ErrNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := resolveContainerID(c.ref, "", c.rows, true)
			if err != c.wantErr || got != c.want {
				t.Fatalf("got (%q, %v), want (%q, %v)", got, err, c.want, c.wantErr)
			}
		})
	}
	t.Run("exact consistent name wins and needs no suffix", func(t *testing.T) {
		got, err := resolveContainerID(uuid, "", []psRow{row(pgID, uuid), row(otherID, uuid+"-20261110T153012")}, true)
		if err != nil || got != pgID {
			t.Fatalf("got (%q, %v)", got, err)
		}
	})
	t.Run("the DB arm never takes a suffixed name", func(t *testing.T) {
		if _, err := resolveContainerID(uuid, "", []psRow{row(pgID, uuid+"-20261110T153012")}, false); err != ErrNotFound {
			t.Fatalf("got %v", err)
		}
	})
}
