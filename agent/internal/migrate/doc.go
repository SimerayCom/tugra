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
// The VOLUME ARM (`--arms volumes|all`, default `databases`) copies declared app volumes (and, gated, a PostgreSQL data
// directory) of a STOPPED source container to the hub's memory relay in resumable parts, with the same boundary rules:
//
//   - It never writes to the source and never removes anything. A running source is refused unless --stop-source is given,
//     and then ONLY that container is stopped (and restarted if the copy does not complete). Quiescence is verified before
//     the first byte and re-checked after the last; the hub stores the fingerprint and refuses to apply when it changed.
//   - The tar helper is the migrator's OWN image (--helper-image / TUGRA_SELF_IMAGE), run with --pull=never, no network,
//     a read-only root, every capability dropped except DAC_READ_SEARCH and the volume mounted read-only: nothing is ever
//     pulled onto the customer's host.
//   - Parts are cut from the raw tar stream (independent gzip members, so a resume compares RAW hashes and never depends on
//     the compressor), each verified by sha256 and exact length at the relay and again on the target; memory is bounded
//     (two buffers). A mismatch against what the hub already committed is `volume-diverged`, never a silent re-send.
//   - Every state is explicit (volume-copied, volume-applied, volume-skipped-running, volume-diverged,
//     volume-source-missing, volume-bind-refused, volume-special-files, volume-disk-insufficient, volume-aborted,
//     volume-not-migrated): nothing is skipped without a reported reason.
//
// The source files mirror the concerns designed in S4-3: scrub.go (secret
// redaction), recipe.go (the pinned recipe/engine contract + child-env build),
// creds.go (per-engine credential discovery), discover.go (itemRef -> container),
// dump.go (no-shell dump -> gzip -> spool+sha256), hubclient.go (the hub HTTP
// client) and run.go (the status-first orchestration + exit-code contract); volume.go
// (volume resolution, quiescence, bind denylist, inventory), runvolume.go (the volume arm's
// orchestration), vxclient.go (the volume-stream hub calls) and vxstream.go (the tar -> parts streamer).
package migrate
