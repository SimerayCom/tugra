#!/usr/bin/env node
// units.mjs parse <size>   docker's human size ("2.147GB", "512MB", "654kB", "0B") as an integer number of bytes.
// `docker system df` and `docker ps -s` print go-units decimal sizes (kB = 1000 B). Used by the fleet scenarios to compare what the
// docker inventory can see against what is really on disk (a bind mount is invisible to docker's volume accounting, C19).
import { fileURLToPath } from "node:url";

const UNIT = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };

export function parseDockerSize(text) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKMGTP]?B)\s*$/.exec(String(text));
  if (!m) throw new Error(`not a docker size: ${JSON.stringify(text)}`);
  return Math.round(Number(m[1]) * UNIT[m[2].toUpperCase()]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd !== "parse" || arg === undefined) { console.error("usage: units.mjs parse <size>"); process.exit(2); }
  try { console.log(parseDockerSize(arg)); } catch (e) { console.error(e.message); process.exit(1); }
}
