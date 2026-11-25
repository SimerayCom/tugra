package coolify

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The Go vocabulary must equal the shared one (packages/shared/src/coolify-secrets.ts): a drift would make the hub ask for a ref
// kind or class the agent does not know.
func TestVocabularyMatchesShared(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/shared/src/coolify-secrets.ts")
	if err != nil {
		t.Skip("shared package not next to the agent")
	}
	list := func(name string) []string {
		m := regexp.MustCompile(`export const ` + name + ` = \[([^\]]*)\]`).FindStringSubmatch(string(raw))
		if m == nil {
			t.Fatalf("%s not found in shared", name)
		}
		var out []string
		for _, q := range regexp.MustCompile(`"([a-z0-9_]+)"`).FindAllStringSubmatch(m[1], -1) {
			out = append(out, q[1])
		}
		return out
	}
	eq := func(name string, got, want []string) {
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s drifted:\n go    %v\n shared %v", name, got, want)
		}
	}
	eq("kinds", Kinds, list("COOLIFY_SECRET_REF_KINDS"))
	eq("classes", Classes, list("COOLIFY_SECRET_CLASSES"))
	eq("wire codes", sortedKeys(okWireCodes, "ok"), sortedOf(list("COOLIFY_SECRET_WIRE_CODES"), "ok"))
	for _, c := range regexp.MustCompile(`COOLIFY_SECRETS_MAX_REFS_PER_FRAME = (\d+)`).FindStringSubmatch(string(raw))[1:] {
		if c != "200" {
			t.Errorf("max refs per frame in shared is %s", c)
		}
	}
}

func sortedKeys(m map[string]bool, skip string) []string {
	var out []string
	for k := range m {
		if k != skip {
			out = append(out, k)
		}
	}
	return sortedOf(out, skip)
}

func sortedOf(in []string, skip string) []string {
	var out []string
	for _, s := range in {
		if s != skip {
			out = append(out, s)
		}
	}
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func TestEveryKindAndClassIsCovered(t *testing.T) {
	for _, k := range Kinds {
		if len(kindTables[k]) == 0 {
			t.Errorf("kind %s has no table", k)
		}
	}
	if len(kindTables) != len(Kinds) {
		t.Errorf("kindTables has %d kinds, Kinds %d", len(kindTables), len(Kinds))
	}
	seen := map[string]bool{}
	for _, ts := range kindTables {
		for _, tb := range ts {
			for _, f := range tb.Fields {
				if !knownClass(f.Class) {
					t.Errorf("%s.%s has unknown class %s", tb.Name, f.Col, f.Class)
				}
				seen[f.Class] = true
				switch f.Form {
				case FormSerialized, FormString, FormAuto, FormPlain:
				default:
					t.Errorf("%s.%s has unknown form %q", tb.Name, f.Col, f.Form)
				}
			}
		}
	}
	for _, c := range Classes {
		if !seen[c] {
			t.Errorf("class %s is never read by any column", c)
		}
	}
}

// T0 is never readable: the app key, Coolify's own passwords and server SSH keys appear in no column of the table, and the one table
// that holds SSH keys is guarded.
func TestT0IsNotReachable(t *testing.T) {
	for kind, ts := range kindTables {
		for _, tb := range ts {
			if strings.Contains(tb.Name, "instance_settings") || tb.Name == "users" || tb.Name == "personal_access_tokens" || tb.Name == "server_settings" {
				t.Errorf("%s reaches %s", kind, tb.Name)
			}
			for _, f := range tb.Fields {
				if strings.Contains(f.Col, "app_key") || strings.Contains(f.Col, "ssh") || f.Col == "password" || f.Col == "remember_token" || f.Col == "two_factor_secret" {
					t.Errorf("%s.%s looks like T0", tb.Name, f.Col)
				}
				if f.Col == "private_key" && (tb.Name != "private_keys" || !strings.Contains(tb.Guard, "is_git_related")) {
					t.Errorf("private_key column outside the guarded table: %s %q", tb.Name, tb.Guard)
				}
			}
		}
	}
	// the T0 table is only reachable under the deploy_key class (T2, opt-in)
	for _, f := range kindTables["private_key"][0].Fields {
		if f.Class != ClassDeployKey {
			t.Errorf("private_keys.%s is under class %s", f.Col, f.Class)
		}
	}
}

func TestBuildQueryIsConstantShapeAndSafe(t *testing.T) {
	tb := kindTables["s3"][0]
	sql, fields, err := BuildQuery(tb, []string{"a1", "b-2"}, map[string]bool{ClassS3: true})
	if err != nil || len(fields) != 2 {
		t.Fatalf("%v %v", err, fields)
	}
	want := "select json_build_object('ref', t.uuid::text, 'f', json_build_object('key', json_build_object('p', to_jsonb(t) ? 'key', 'v', to_jsonb(t)->>'key'), 'secret', json_build_object('p', to_jsonb(t) ? 'secret', 'v', to_jsonb(t)->>'secret')))::text from s3_storages t where t.uuid::text in ('a1','b-2');\n"
	if sql != want {
		t.Fatalf("query drifted:\n%s", sql)
	}
	// No consented column: no statement at all.
	if s, f, _ := BuildQuery(tb, []string{"a1"}, map[string]bool{ClassEnv: true}); s != "" || f != nil {
		t.Fatalf("a statement was built for an unconsented class: %s", s)
	}
	for _, bad := range []string{"a'", "a b", "a;", "a\n", "", strings.Repeat("a", 65), "a--b'", "a\\"} {
		if _, _, err := BuildQuery(tb, []string{bad}, map[string]bool{ClassS3: true}); err == nil {
			t.Errorf("id %q accepted", bad)
		}
	}
	if _, _, err := BuildQuery(Table{Name: "x; drop", Key: "uuid", Fields: tb.Fields}, []string{"a"}, map[string]bool{ClassS3: true}); err == nil {
		t.Error("a bad table name must be refused")
	}
}

func TestSplitRef(t *testing.T) {
	for _, ok := range []string{"env:abc", "s3:x_1", "database:ok4w0cs", "notification:12", "private_key:Ab-9"} {
		if _, _, good := SplitRef(ok); !good {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "env", "env:", ":abc", "ENV:abc", "env:a b", "env:a:b", "nope:abc", "env:" + strings.Repeat("a", 65), "env:abc\n", "env:a'b", "env:é"} {
		if _, _, good := SplitRef(bad); good {
			t.Errorf("%q accepted", bad)
		}
	}
}

func FuzzSplitRefAndValidate(f *testing.F) {
	for _, s := range []string{"env:abc", "s3:'; drop", "x", "database:" + strings.Repeat("z", 70)} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, ref string) {
		kind, id, ok := SplitRef(ref)
		if !ok {
			return
		}
		if !idRe.MatchString(id) || kindTables[kind] == nil || ref != kind+":"+id {
			t.Fatalf("accepted %q as %q %q", ref, kind, id)
		}
		// whatever got through can be put in SQL: only the id charset, so nothing can close the literal
		if strings.ContainsAny(id, "'\"\\;\n\r\x00 ") {
			t.Fatalf("id %q carries a SQL metacharacter", id)
		}
	})
}
