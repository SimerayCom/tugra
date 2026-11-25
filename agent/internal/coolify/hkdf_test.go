package coolify

import (
	"crypto/hkdf"
	"crypto/sha256"

	"github.com/SimerayCom/tugra/agent/internal/coolify/seal"
)

func hkdfKey(shared []byte, runID, keyID string) ([]byte, error) {
	return hkdf.Key(sha256.New, shared, []byte(runID), seal.HKDFInfo+keyID, 32)
}
