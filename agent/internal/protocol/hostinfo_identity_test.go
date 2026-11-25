package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// The host identity facts ride the existing host_info frame: hashes and ids only, omitted when unknown, never any content.
func TestHostInfoIdentityFactsAreOptionalOnTheWire(t *testing.T) {
	b, err := json.Marshal(HostInfoMsg{Type: "host_info", Info: HostInfo{OS: "ubuntu"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "machineIdHash") || strings.Contains(string(b), "dockerEngineId") {
		t.Fatalf("unknown facts must be omitted: %s", b)
	}
	b, err = json.Marshal(HostInfoMsg{Type: "host_info", Info: HostInfo{MachineIDHash: "ab", DockerEngineID: "X:Y"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"machineIdHash":"ab"`) || !strings.Contains(string(b), `"dockerEngineId":"X:Y"`) {
		t.Fatalf("facts missing from the frame: %s", b)
	}
}
