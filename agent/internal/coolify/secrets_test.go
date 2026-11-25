package coolify

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

var testKey = []byte("0123456789abcdef0123456789abcdef")

func testAppKey() string { return "base64:" + base64.StdEncoding.EncodeToString(testKey) }

// seeded builds a fake Coolify holding one env value, one database password and one S3 pair, all encrypted under testKey.
func seeded(t *testing.T) *fakeHost {
	h := newFakeHost(testAppKey())
	h.put("environment_variables", "env1", "value", sp(string(laravelEncryptCBC(t, testKey, phpSerialize("postgres://app:s3cr3t@db/app")))))
	h.put("standalone_postgresqls", "db1", "postgres_password", sp(string(laravelEncryptCBC(t, testKey, []byte("pg-pass-1")))))
	h.put("s3_storages", "s31", "key", sp(string(laravelEncryptCBC(t, testKey, []byte("AKIAEXAMPLE")))))
	h.put("s3_storages", "s31", "secret", sp(string(laravelEncryptCBC(t, testKey, []byte("s3-secret-1")))))
	return h
}

func TestHappyPathSealsEveryValueAndOnlyTheConsentedOnes(t *testing.T) {
	host := seeded(t)
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"env", "db_credentials", "s3"}, []string{"env:env1", "database:db1", "s3:s31"}, nil))
	plain, codes := h.openRecords(res)
	want := map[string]string{
		"env:env1|value": "postgres://app:s3cr3t@db/app", "database:db1|postgres_password": "pg-pass-1",
		"s3:s31|key": "AKIAEXAMPLE", "s3:s31|secret": "s3-secret-1",
	}
	for k, v := range want {
		if plain[k] != v {
			t.Errorf("%s = %q, want %q", k, plain[k], v)
		}
	}
	if len(plain) != len(want) {
		t.Errorf("extra values: %v", plain)
	}
	if len(codes) != 0 {
		t.Errorf("unexpected codes %v", codes)
	}
	last := res[len(res)-1]
	if !last.Final || !last.OK {
		t.Fatalf("last result must be a final success: %+v", last)
	}
	// Only the tables of the consented kinds were queried, columns of other classes never named.
	sql := strings.Join(host.psqlSQL, "")
	if strings.Contains(sql, "private_keys") || strings.Contains(sql, "applications") || strings.Contains(sql, "scheduled_tasks") {
		t.Fatalf("queried tables the request did not name: %s", sql)
	}
}

func TestUnconsentedClassIsNeverSelected(t *testing.T) {
	host := seeded(t)
	host.put("applications", "app1", "http_basic_auth_password", sp(string(laravelEncryptCBC(t, testKey, []byte("basic")))))
	host.put("applications", "app1", "git_https_password", sp(string(laravelEncryptCBC(t, testKey, []byte("gitpw")))))
	h := newHarness(t, host)
	// basic_auth consented, git_app_key (T2) not: the git password column must not even appear in the SQL.
	res := h.send(h.frame([]string{"basic_auth"}, []string{"application:app1"}, nil))
	plain, _ := h.openRecords(res)
	if plain["application:app1|http_basic_auth_password"] != "basic" || len(plain) != 4 && plain["application:app1|git_https_password"] != "" {
		t.Fatalf("plain = %v", plain)
	}
	if strings.Contains(strings.Join(host.psqlSQL, ""), "git_https_password") {
		t.Fatal("a column of an unconsented class was selected")
	}
}

func TestPreviousKeyAndErrorsAreReportedPerValue(t *testing.T) {
	host := newFakeHost(testAppKey())
	old := []byte("ffffffffffffffffffffffffffffffff")
	host.prevKeys = "base64:" + base64.StdEncoding.EncodeToString(old)
	host.put("environment_variables", "viaold", "value", sp(string(laravelEncryptCBC(t, old, phpSerialize("old-secret")))))
	host.put("environment_variables", "wrongkey", "value", sp(string(laravelEncryptCBC(t, []byte("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), phpSerialize("x")))))
	host.put("environment_variables", "nullval", "value", nil)
	host.put("environment_variables", "obj", "value", sp(string(laravelEncryptCBC(t, testKey, []byte(`O:8:"stdClass":0:{}`)))))
	h := newHarness(t, host)
	refs := []string{"env:viaold", "env:wrongkey", "env:nullval", "env:obj", "env:absent"}
	res := h.send(h.frame([]string{"env"}, refs, nil))
	plain, codes := h.openRecords(res)
	if plain["env:viaold|value"] != "old-secret" {
		t.Errorf("previous key value: %v", plain)
	}
	if codes["env:wrongkey|value"] != "bad_mac" || codes["env:obj|value"] != "unsupported_serialization" {
		t.Errorf("codes = %v", codes)
	}
	if codes["env:absent|*"] != "column_missing" {
		t.Errorf("a ref found nowhere must be reported: %v", codes)
	}
	if _, ok := plain["env:nullval|value"]; ok {
		t.Error("NULL must produce no value")
	}
	if _, ok := codes["env:nullval|value"]; ok {
		t.Error("NULL is not an error")
	}
	if codes["env:viaold|*"] != "key_prev" {
		t.Errorf("key_prev note missing: %v", codes)
	}
	if !res[len(res)-1].Final || !res[len(res)-1].OK {
		t.Fatal("run must finish OK even with unreadable values")
	}
}

func TestMissingAppKeyAnswersNoKeyAndStartsNoHelper(t *testing.T) {
	host := seeded(t)
	host.appKey = ""
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil))
	_, codes := h.openRecords(res)
	if codes["env:env1|value"] != "no_key" {
		t.Fatalf("codes = %v", codes)
	}
	for _, a := range host.argvs {
		if a[1] == "run" {
			t.Fatal("no helper must start without a key")
		}
	}
}

func TestMissingTableAndColumnAreReportedNotGuessed(t *testing.T) {
	host := newFakeHost(testAppKey())
	host.missing["standalone_clickhouses"] = true
	host.put("standalone_mariadbs", "m1", "mariadb_password", sp(string(laravelEncryptCBC(t, testKey, []byte("mp")))))
	// mariadb_root_password column is absent in this "version": only the password is stored.
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"db_credentials"}, []string{"database:m1"}, nil))
	plain, codes := h.openRecords(res)
	if plain["database:m1|mariadb_password"] != "mp" || codes["database:m1|mariadb_root_password"] != "column_missing" {
		t.Fatalf("plain %v codes %v", plain, codes)
	}
}

func TestNothingIsRunBeforeEveryCheckPasses(t *testing.T) {
	base := func(h *harness) protocol.ServerMsg {
		return h.frame([]string{"env"}, []string{"env:env1"}, nil)
	}
	type tc struct {
		name     string
		mutate   func(h *harness, m *protocol.ServerMsg)
		wantCode string // "" = dropped silently, no reply
		pre      func(h *harness)
	}
	cases := []tc{
		{name: "unsigned", mutate: func(h *harness, m *protocol.ServerMsg) { m.Sig = "" }},
		{name: "garbage signature", mutate: func(h *harness, m *protocol.ServerMsg) { m.Sig = "AAAA" }},
		{name: "signed by another key", mutate: func(h *harness, m *protocol.ServerMsg) { other := newHarness(t, newFakeHost("")); other.sign(m) }},
		{name: "field changed after signing (refs)", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = []string{"env:other"} }},
		{name: "field changed after signing (recipient)", mutate: func(h *harness, m *protocol.ServerMsg) {
			m.RecipientKey = base64.StdEncoding.EncodeToString(make([]byte, 32))
		}},
		{name: "field changed after signing (classes)", mutate: func(h *harness, m *protocol.ServerMsg) { m.Classes = []string{"env", "deploy_key"} }},
		{name: "expired", mutate: func(h *harness, m *protocol.ServerMsg) { m.Exp = h.now.Unix() - 120; h.sign(m) }, wantCode: RefusedExpired},
		{name: "exp too far ahead", mutate: func(h *harness, m *protocol.ServerMsg) { m.Exp = h.now.Unix() + 3600; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "capability not granted", pre: func(h *harness) { h.setCap("coolify_secrets", false) }, wantCode: RefusedDenied},
		{name: "wrong signed capability", mutate: func(h *harness, m *protocol.ServerMsg) { m.Capability = "database"; h.sign(m) }, wantCode: RefusedDenied},
		{name: "empty classes", mutate: func(h *harness, m *protocol.ServerMsg) { m.Classes = nil; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "unknown class", mutate: func(h *harness, m *protocol.ServerMsg) { m.Classes = []string{"everything"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "duplicate class", mutate: func(h *harness, m *protocol.ServerMsg) { m.Classes = []string{"env", "env"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "no refs", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = nil; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "too many refs", mutate: func(h *harness, m *protocol.ServerMsg) {
			m.Refs = nil
			for i := 0; i < 201; i++ {
				m.Refs = append(m.Refs, "env:r"+strings.Repeat("a", i%5)+string(rune('a'+i%26))+strings.Repeat("b", i/26))
			}
			h.sign(m)
		}, wantCode: RefusedBadRequest},
		{name: "duplicate ref", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = []string{"env:a", "env:a"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "unknown kind", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = []string{"pg_shadow:x"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "sql in the id", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = []string{"env:a'); drop table x;--"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "quote in the id", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = []string{"env:a'b"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "newline in the id", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = []string{"env:a\nb"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "kind without a consented class", mutate: func(h *harness, m *protocol.ServerMsg) { m.Refs = []string{"s3:x"}; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "bad run id", mutate: func(h *harness, m *protocol.ServerMsg) { m.RunID = "run 1"; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "recipient not base64", mutate: func(h *harness, m *protocol.ServerMsg) { m.RecipientKey = "%%%"; h.sign(m) }, wantCode: RefusedBadRequest},
		{name: "recipient wrong length", mutate: func(h *harness, m *protocol.ServerMsg) {
			m.RecipientKey = base64.StdEncoding.EncodeToString(make([]byte, 31))
			h.sign(m)
		}, wantCode: RefusedBadRequest},
		{name: "recipient all zero (low order)", mutate: func(h *harness, m *protocol.ServerMsg) {
			m.RecipientKey = base64.StdEncoding.EncodeToString(make([]byte, 32))
			h.sign(m)
		}, wantCode: RefusedBadRequest},
		{name: "recipient order-8 point", mutate: func(h *harness, m *protocol.ServerMsg) {
			m.RecipientKey = base64.StdEncoding.EncodeToString([]byte{0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00})
			h.sign(m)
		}, wantCode: RefusedBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			host := seeded(t)
			h := newHarness(t, host)
			if c.pre != nil {
				c.pre(h)
			}
			m := base(h)
			if c.mutate != nil {
				c.mutate(h, &m)
			}
			res := h.send(m)
			if host.runs != 0 {
				t.Fatalf("a refused frame started %d commands: %v", host.runs, host.argvs)
			}
			if c.wantCode == "" {
				if len(res) != 0 {
					t.Fatalf("a forged frame must get no reply, got %+v", res)
				}
				return
			}
			if len(res) != 1 || res[0].OK || res[0].Code != c.wantCode || !res[0].Final || len(res[0].Records) != 0 {
				t.Fatalf("reply = %+v, want refusal %s", res, c.wantCode)
			}
		})
	}
}

func TestReplayIsRefusedAcrossGatesSharingState(t *testing.T) {
	host := seeded(t)
	h := newHarness(t, host)
	m := h.frame([]string{"env"}, []string{"env:env1"}, nil)
	if res := h.send(m); !res[len(res)-1].OK {
		t.Fatalf("first: %+v", res)
	}
	res := h.send(m)
	if len(res) != 1 || res[0].Code != RefusedReplay {
		t.Fatalf("replay: %+v", res)
	}
	// A new connection (a new Gate) over the same process state still refuses it.
	h2 := newHarness(t, host)
	h2.hubPub, h2.hubKey, h2.state = h.hubPub, h.hubKey, h.state
	h2.gate = NewGate(Config{ServerID: "srv-1", AgentImage: "img:1", HubPub: h.hubPub, Allows: func(string) bool { return true }, Send: func(v any) error { h2.sent = append(h2.sent, v.(protocol.CoolifySecretsResult)); return nil }, Now: h.gate.c.Now, Run: host.run, State: h.state})
	h2.gate.Handle(context.Background(), m)
	h2.gate.Wait()
	if len(h2.sent) != 1 || h2.sent[0].Code != RefusedReplay {
		t.Fatalf("replay across connections: %+v", h2.sent)
	}
}

func TestFrameForAnotherServerDoesNotVerify(t *testing.T) {
	host := seeded(t)
	h := newHarness(t, host)
	m := h.frame([]string{"env"}, []string{"env:env1"}, nil)
	f := protocol.CoolifySecretsFields{ServerID: "srv-OTHER", ReqID: m.ReqID, RunID: m.RunID, Classes: m.Classes, Refs: m.Refs, RecipientKey: m.RecipientKey, Exp: m.Exp, Capability: m.Capability}
	m.Sig = base64.StdEncoding.EncodeToString(sign(h, protocol.CanonicalCoolifySecrets(f)))
	if res := h.send(m); len(res) != 0 || host.runs != 0 {
		t.Fatalf("a frame signed for srv-OTHER must be dropped: %+v", res)
	}
}

func TestSingleFlightAndRateLimit(t *testing.T) {
	host := seeded(t)
	h := newHarness(t, host)
	gate := make(chan struct{})
	started := make(chan struct{}, 1)
	host.helperHook = func() { started <- struct{}{}; <-gate }
	first := h.frame([]string{"env"}, []string{"env:env1"}, nil)
	h.gate.Handle(context.Background(), first)
	<-started
	second := h.frame([]string{"env"}, []string{"env:env1"}, nil)
	h.gate.Handle(context.Background(), second)
	h.capMu.Lock()
	busy := len(h.sent) == 1 && h.sent[0].Code == RefusedBusy && h.sent[0].ReqID == second.ReqID
	h.capMu.Unlock()
	if !busy {
		t.Fatalf("a second concurrent request must be refused busy: %+v", h.sent)
	}
	close(gate)
	h.gate.Wait()

	// Rate window: the 6 requests per minute budget (the busy one above did not count) is then used up.
	host.helperHook = nil
	for i := 0; i < 5; i++ {
		if r := h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil)); !r[len(r)-1].OK {
			t.Fatalf("request %d: %+v", i, r)
		}
	}
	r := h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil))
	if len(r) != 1 || r[0].Code != RefusedRateLimited {
		t.Fatalf("7th request in a minute: %+v", r)
	}
	h.now = h.now.Add(61 * time.Second)
	if r := h.send(h.frame([]string{"env"}, []string{"env:env1"}, func(m *protocol.ServerMsg) { m.Exp = h.now.Unix() + 300 })); !r[len(r)-1].OK {
		t.Fatalf("after the window: %+v", r)
	}
}

func TestRevokedCapabilityStopsTheRun(t *testing.T) {
	host := seeded(t)
	h := newHarness(t, host)
	// The owner revokes the grant while the helper is running: no further record is relayed and the run ends refused.
	host.helperHook = func() { h.setCap("coolify_secrets", false) }
	res := h.send(h.frame([]string{"env", "db_credentials", "s3"}, []string{"env:env1", "database:db1", "s3:s31"}, nil))
	last := res[len(res)-1]
	if last.OK || last.Code != RefusedRevoked || !last.Final {
		t.Fatalf("last = %+v", last)
	}
	for _, r := range res {
		for _, rec := range r.Records {
			if rec.Env != "" {
				t.Fatalf("a value was relayed after the revocation: %+v", rec)
			}
		}
	}
	// And the helper container was removed, not left running.
	removed := false
	for _, a := range host.argvs {
		if len(a) > 2 && a[1] == "rm" && strings.HasPrefix(a[len(a)-1], "tugra-coolify-open-") {
			removed = true
		}
	}
	if !removed {
		t.Fatal("the helper container must be force-removed after an aborted run")
	}
}

func TestRevokedBeforeStartReadsNothing(t *testing.T) {
	host := seeded(t)
	h := newHarness(t, host)
	m := h.frame([]string{"env"}, []string{"env:env1"}, nil)
	h.setCap("coolify_secrets", false)
	res := h.send(m)
	if len(res) != 1 || res[0].Code != RefusedDenied || host.runs != 0 {
		t.Fatalf("%+v runs=%d", res, host.runs)
	}
}

func TestHelperOutputIsFilteredByTheAgent(t *testing.T) {
	host := seeded(t)
	// A helper that misbehaves (or an image swapped for another) cannot push plaintext, an unasked ref or another class through the agent.
	host.helperTrash = `{"ref":"env:env1","field":"value","class":"env","env":"plaintext-not-an-envelope"}` + "\n" +
		`{"ref":"env:never-asked","field":"value","class":"env","env":"tse1.AAAA"}` + "\n" +
		`{"ref":"env:env1","field":"value","class":"deploy_key","env":"tse1.AAAA"}` + "\n" +
		`{"ref":"env:env1","field":"value","code":"free text with s3cr3t"}` + "\n" +
		`not json at all` + "\n"
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil))
	for _, r := range res {
		for _, rec := range r.Records {
			if rec.Env == "plaintext-not-an-envelope" || rec.Ref == "env:never-asked" || rec.Class == "deploy_key" || strings.Contains(rec.Code, "free text") {
				t.Fatalf("relayed %+v", rec)
			}
		}
	}
	plain, _ := h.openRecords(res)
	if plain["env:env1|value"] == "" {
		t.Fatal("the real record must still arrive")
	}
	if !strings.Contains(h.logs.String(), "malformed helper lines dropped") {
		t.Fatal("dropped lines must be counted in the log")
	}
}

func TestHelperFailureEndsTheRunWithAFixedCode(t *testing.T) {
	host := seeded(t)
	host.failHelper = true
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil))
	last := res[len(res)-1]
	if last.OK || last.Code != RefusedFailed || !last.Final {
		t.Fatalf("%+v", last)
	}
}

func TestNotConfiguredWithoutLocalImage(t *testing.T) {
	host := seeded(t)
	h := newHarness(t, host)
	h.gate.c.AgentImage = ""
	res := h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil))
	if len(res) != 1 || res[0].Code != RefusedNotConfigured || host.runs != 0 {
		t.Fatalf("%+v", res)
	}
	h.gate.c.AgentImage = "-evil"
	res = h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil))
	if len(res) != 1 || res[0].Code != RefusedNotConfigured {
		t.Fatalf("an image starting with '-' must be refused: %+v", res)
	}
}

func TestPrivateKeyRefsOnlyReachGitRelatedRows(t *testing.T) {
	host := newFakeHost(testAppKey())
	host.put("private_keys", "dk1", "private_key", sp(string(laravelEncryptCBC(t, testKey, []byte("-----BEGIN KEY-----deploy")))))
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"deploy_key"}, []string{"private_key:dk1"}, nil))
	plain, _ := h.openRecords(res)
	if plain["private_key:dk1|private_key"] == "" {
		t.Fatalf("%v", plain)
	}
	if !strings.Contains(strings.Join(host.psqlSQL, ""), "t.is_git_related is true") {
		t.Fatal("the T0 guard (is_git_related) must be part of the statement")
	}
}

func TestManyValuesAreBatched(t *testing.T) {
	host := newFakeHost(testAppKey())
	var refs []string
	for i := 0; i < 150; i++ {
		id := "e" + strings.Repeat("x", i%7) + strings.ToLower(string(rune('a'+i%26))) + strings.Repeat("y", i/26)
		host.put("environment_variables", id, "value", sp(string(laravelEncryptCBC(t, testKey, phpSerialize("v-"+id)))))
		refs = append(refs, "env:"+id)
	}
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"env"}, refs, nil))
	plain, _ := h.openRecords(res)
	if len(plain) != 150 {
		t.Fatalf("got %d values", len(plain))
	}
	if len(res) < 2 {
		t.Fatalf("150 records must not fit in one result frame (max %d each): %d frames", maxResultRecords, len(res))
	}
	for i, r := range res {
		if len(r.Records) > maxResultRecords {
			t.Fatalf("frame %d has %d records", i, len(r.Records))
		}
		if r.Final != (i == len(res)-1) {
			t.Fatalf("only the last frame may be final")
		}
	}
	data, _ := json.Marshal(res)
	if len(data) > 8<<20 {
		t.Fatal("frames too large")
	}
}

func TestNoFilesWritten(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("TMPDIR", dir)
	host := seeded(t)
	h := newHarness(t, host)
	h.send(h.frame([]string{"env"}, []string{"env:env1"}, nil))
	ents, _ := os.ReadDir(dir)
	if len(ents) != 0 {
		t.Fatalf("the gate wrote files: %v", ents)
	}
}

var _ = sync.Mutex{}

// Application build text and a service's config files are sealed under the compose class; a column this Coolify version lacks is a normal
// answer (no record), a required column that is missing still reports column_missing.
func TestApplicationTextAndFileVolumesUnderServiceCompose(t *testing.T) {
	host := newFakeHost(testAppKey())
	host.put("applications", "app1", "dockerfile", sp("FROM alpine\nRUN echo hi"))
	host.put("applications", "app1", "custom_labels", sp("dHJhZWZpay5lbmFibGU9dHJ1ZQ=="))
	host.put("local_file_volumes", "12", "content", sp(string(laravelEncryptCBC(t, testKey, []byte("listen = 8080")))))
	host.put("services", "svc1", "docker_compose_raw", sp("services:\n  web:\n    image: nginx\n"))
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"service_compose"}, []string{"application:app1", "file_volume:12", "service:svc1"}, nil))
	plain, codes := h.openRecords(res)
	want := map[string]string{
		"application:app1|dockerfile":     "FROM alpine\nRUN echo hi",
		"application:app1|custom_labels":  "dHJhZWZpay5lbmFibGU9dHJ1ZQ==",
		"file_volume:12|content":          "listen = 8080",
		"service:svc1|docker_compose_raw": "services:\n  web:\n    image: nginx\n",
	}
	for k, v := range want {
		if plain[k] != v {
			t.Errorf("%s = %q, want %q", k, plain[k], v)
		}
	}
	if len(codes) != 0 {
		t.Fatalf("a missing optional column must not be reported: %v", codes)
	}
	// the basic-auth class is not consented: its column is never even named
	if strings.Contains(strings.Join(host.psqlSQL, ""), "http_basic_auth_password") {
		t.Fatal("an unconsented class was selected")
	}
}

func TestRequiredColumnMissingStillReports(t *testing.T) {
	host := newFakeHost(testAppKey())
	host.put("services", "svc1", "name", sp("x")) // the row exists, the compose column does not
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"service_compose"}, []string{"service:svc1"}, nil))
	_, codes := h.openRecords(res)
	if codes["service:svc1|docker_compose_raw"] != "column_missing" {
		t.Fatalf("%v", codes)
	}
}
