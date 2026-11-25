package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// The literal below is the same one the shared spec asserts (packages/shared/src/coolify-ssh.spec.ts).
func TestCanonicalCoolifySSHSharedVector(t *testing.T) {
	got := CanonicalCoolifySSH(CoolifySSHFields{
		ReqID: "r1", Op: "probe", CoolifyServerUUID: "abc123def456", ScriptSha256: strings.Repeat("a", 64), PayloadSha256: strings.Repeat("b", 64),
		UseSudo: false, ExpectedHostKeyFp: "", Exp: 1800000000, Capability: "coolify_ssh",
	})
	want := "cssh\n2:r1\n5:probe\n12:abc123def456\n64:" + strings.Repeat("a", 64) + "\n64:" + strings.Repeat("b", 64) + "\n1:0\n0:\n10:1800000000\n11:coolify_ssh"
	if got != want {
		t.Fatalf("canonical mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestCanonicalCoolifySSHSudoFlagIsSigned(t *testing.T) {
	f := CoolifySSHFields{ReqID: "r", Op: "install", CoolifyServerUUID: "abc123def456", Exp: 1, Capability: "coolify_ssh"}
	a := CanonicalCoolifySSH(f)
	f.UseSudo = true
	if CanonicalCoolifySSH(f) == a {
		t.Fatal("useSudo must change the signed text")
	}
}

func TestCoolifySSHCodesAreTheTwentyOne(t *testing.T) {
	if len(CoolifySSHCodes) != 21 {
		t.Fatalf("got %d codes", len(CoolifySSHCodes))
	}
}

// The wire names are a contract with @tugra/shared (CoolifyProbeFacts, CoolifySshResultMsg, CoolifySshReqMsg): a renamed field would be dropped silently.
func TestCoolifySSHJSONNamesMirrorShared(t *testing.T) {
	uid, yes, disk := 0, true, 10
	b, err := json.Marshal(CoolifySSHResult{
		Type: "coolify_ssh_result", ReqID: "r", OK: true, Code: "ok_installed", ContainerID: "c", DurationMs: 5,
		Probe: &CoolifyProbeFacts{UID: &uid, DockerAccess: &yes, SudoNoPassword: &yes, Arch: "x86_64", Agent: "none", DiskFreeMb: &disk, HubReachable: &yes, SSHHostKeyFp: "f", HostKeyPinned: &yes, MachineIDHash: "m", DockerEngineID: "e"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]json.RawMessage
	_ = json.Unmarshal(b, &top)
	for _, k := range []string{"type", "reqId", "ok", "code", "probe", "containerId", "durationMs"} {
		if _, ok := top[k]; !ok {
			t.Errorf("result lacks %q", k)
		}
	}
	var probe map[string]any
	_ = json.Unmarshal(top["probe"], &probe)
	for _, k := range []string{"uid", "dockerAccess", "sudoNoPassword", "arch", "agent", "diskFreeMb", "hubReachable", "sshHostKeyFp", "hostKeyPinned", "machineIdHash", "dockerEngineId"} {
		if _, ok := probe[k]; !ok {
			t.Errorf("probe lacks %q", k)
		}
	}
	var in ServerMsg
	req := `{"type":"coolify_ssh_req","reqId":"r","op":"install","coolifyServerUuid":"u","scriptSha256":"s","payloadSha256":"p","useSudo":true,"expectedHostKeyFp":"f","exp":9,"capability":"coolify_ssh","sig":"g","script":"x","payload":"y"}`
	if err := json.Unmarshal([]byte(req), &in); err != nil {
		t.Fatal(err)
	}
	if in.CoolifyServerUUID != "u" || in.ScriptSha256 != "s" || in.PayloadSha256 != "p" || !in.UseSudo || in.ExpectedHostKeyFp != "f" || in.Exp != 9 || in.Script != "x" || in.Payload != "y" || in.Op != "install" || in.Capability != "coolify_ssh" {
		t.Fatalf("request fields not read: %+v", in)
	}
}
