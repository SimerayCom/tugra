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
		"registry.example.com:5000/lib/postgres:16": "POSTGRES",
	}
	for img, want := range cases {
		if got := classifyEngine(img, nil); got != want {
			t.Errorf("classify(%q)=%q want %q", img, got, want)
		}
	}
	// env-signature fallback for an unrecognised image
	if got := classifyEngine("custom/db:1", map[string]string{"POSTGRES_PASSWORD": "x"}); got != "POSTGRES" {
		t.Errorf("env fallback failed: %q", got)
	}
}
