package coolify

import "crypto/ed25519"

func ed25519Sign(k ed25519.PrivateKey, canonical string) []byte {
	return ed25519.Sign(k, []byte(canonical))
}
