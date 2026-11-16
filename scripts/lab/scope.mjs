#!/usr/bin/env node
// Which docker volumes and staging directories belong to THIS lab (plain Node, stdlib only). The lab hub's own database is the
// record: every app, database, volume transfer and app move in it was created by the lab, so the production-shaped names
// derived from those ids (tugra_appv_<appId>_<vol>, tugra_dbv_<dbId>, tugra_restore_rb_vx<transferId>, app-moves/<id>) are
// lab-owned and nothing else is. A name prefix alone would also match a real server's volumes.
//
//   scope.mjs volumes|dirs < lines
// stdin lines: "app <id>", "db <id>", "transfer <id>", "move <id>" (from `seed.mjs ids`) plus "volume <name>" / "dir <name>"
// candidates (from `docker volume ls -q` / `ls app-moves`). stdout: the candidates that belong to the lab, one per line.
// The lab's own fixed volume names are always lab-owned (they only ever exist because a lab script created them).
import { readFileSync } from "node:fs";

export const FIXED_VOLUMES = ["lab-src", "lab-src2", "lab-pgsrc", "lab-agent-state", "lab-agent-b-state"];

export function select(mode, lines) {
  const ids = { app: new Set(), db: new Set(), transfer: new Set(), move: new Set() };
  const cands = [];
  for (const raw of lines) {
    const m = /^(app|db|transfer|move|volume|dir) (\S+)$/.exec(raw.trim());
    if (!m) continue;
    if (m[1] === "volume" || m[1] === "dir") cands.push([m[1], m[2]]);
    else ids[m[1]].add(m[2]);
  }
  const out = [];
  for (const [kind, name] of cands) {
    if (mode === "volumes" && kind === "volume") {
      let own = FIXED_VOLUMES.includes(name);
      for (const id of ids.app) if (name.startsWith(`tugra_appv_${id}_`)) own = true;
      for (const id of ids.db) if (name === `tugra_dbv_${id}`) own = true;
      for (const id of ids.transfer) if (name === `tugra_restore_rb_vx${id}` || name.startsWith(`tugra_restore_rb_vx${id}_`)) own = true;
      if (own) out.push(name);
    } else if (mode === "dirs" && kind === "dir") {
      if (ids.transfer.has(name) || ids.move.has(name)) out.push(name);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode !== "volumes" && mode !== "dirs") { console.error("usage: scope.mjs volumes|dirs < lines"); process.exit(2); }
  for (const n of select(mode, readFileSync(0, "utf8").split("\n"))) console.log(n);
}
