#!/usr/bin/env bash
# Fail if the committed OpenAPI contract (apps/hub-api/openapi.json) has a BREAKING change versus a base ref.
# The drift-guard (the openapi jest test) already proves the committed spec matches the code; this adds the
# other half — that the shipped contract stays backward-compatible. CI runs it on pull requests; it is also
# runnable locally:  scripts/openapi-breaking.sh [base-ref]   (default: origin/main)
set -uo pipefail

BASE_REF="${1:-origin/main}"
SPEC="apps/hub-api/openapi.json"

if ! command -v oasdiff >/dev/null 2>&1; then
  echo "oasdiff not found on PATH (install: go install github.com/oasdiff/oasdiff@latest)" >&2
  exit 2
fi

# A missing base REF is a real error in CI (a broken/typo'd ref must fail, not silently pass); only a base ref
# that EXISTS but has no spec yet is a legitimate skip (the spec is brand new on this branch).
if ! git rev-parse --verify -q "${BASE_REF}^{commit}" >/dev/null; then
  if [ -n "${CI:-}" ]; then
    echo "::error::base ref ${BASE_REF} could not be resolved — cannot run the breaking-change check." >&2
    exit 1
  fi
  echo "base ref ${BASE_REF} not found — skipping (local run)."
  exit 0
fi

base="$(mktemp)"
trap 'rm -f "$base"' EXIT

if ! git show "${BASE_REF}:${SPEC}" >"$base" 2>/dev/null; then
  echo "no ${SPEC} at ${BASE_REF} — skipping (the spec is new on this branch)."
  exit 0
fi

echo "Checking ${SPEC} for breaking changes vs ${BASE_REF}…"
oasdiff breaking "$base" "$SPEC" --fail-on ERR
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "::error::The API contract has a BREAKING change vs ${BASE_REF}. Mark the old shape 'deprecated' in the" \
    "spec (optionally with an x-sunset date) and keep serving it, or introduce the change under a new API" \
    "version — don't remove or alter a shipped endpoint outright." >&2
fi
exit "$rc"
