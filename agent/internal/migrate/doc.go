// Package migrate implements the `tugra-agent migrate` subcommand: the one-click
// data migrator that runs ON AN UNTRUSTED source host (e.g. a Coolify server),
// authenticated by a one-time migration token, and streams each source DB dump to
// the Tugra hub, which restores it into a freshly provisioned destination DB.
//
// This whole package is a security boundary. The non-negotiable invariants:
//
//   - The dump child process NEVER inherits os.Environ(): its env is built from a
//     closed allowlist (see childEnvAllowlist) plus the three TUGRA_SRC_* vars and
//     the recipe's one bound secret name. The migration token therefore can never
//     reach a recipe or an in-container tool.
//   - The PASSWORD is NEVER placed on an argv (host- or container-visible): it travels
//     ONLY as a bound `docker exec -e NAME` sourced from the child env. The user and db
//     names DO appear on the argv (the dump tools take them as options/operands, exactly
//     as the recipe requires), but they are validated to a strict charset first — no
//     leading '-', no shell metacharacter, no control byte — so they can never be read as
//     an option or re-parsed as code. They are also registered with the scrubber so a log
//     line can never echo them.
//   - The dump command the hub serves is not trusted as code. Each engine's argv is
//     built IN GO from a pinned template and run WITHOUT a shell; the hub's command
//     string is compared byte-for-byte to a compiled-in golden as a drift tripwire,
//     so the hub can choose neither the binary, nor the container, nor an env name.
//   - Everything fails closed: an unresolved credential, an engine we cannot prove,
//     a recipe that drifts from the compiled contract, or a version skew SKIPS the
//     item (or aborts the run) rather than guessing. A missing recipe is never an
//     empty, silently-successful dump.
//
// The source files mirror the concerns designed in S4-3: scrub.go (secret
// redaction), recipe.go (the pinned recipe/engine contract + child-env build),
// creds.go (per-engine credential discovery), discover.go (itemRef -> container),
// dump.go (no-shell dump -> gzip -> spool+sha256), hubclient.go (the hub HTTP
// client) and run.go (the status-first orchestration + exit-code contract).
package migrate
