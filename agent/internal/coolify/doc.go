// Package coolify holds the agent side of the Coolify hub takeover: the read of Coolify's own database on this host, the sealed secret
// helper (lane B) and the SSH install of the agent on Coolify-known servers (lane C). Each lane adds its own files here; this file only
// names the package so the lanes do not collide on it. Capability and frame names live in internal/protocol.
package coolify
