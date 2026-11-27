import { sectionLimits, CFYA, SCHEMA_SECTION } from "./coolify-agent-sql";
import { CFY } from "./coolify-read-script";
import { CoolifyReadError } from "./coolify-inventory";

/**
 * Parse the output of the agent-read script (coolify-agent-sql.ts) into rows per section. Strict where the v1 parser is lenient:
 * the read is the source of an import plan, so a missing marker, a session that did not confirm REPEATABLE READ READ ONLY, or a
 * section whose body is not a JSON array makes the WHOLE read unreadable. Nothing is guessed and nothing is half-read.
 */

export type Row = Record<string, unknown>;

export interface AgentRead {
  /** The `coolify` container's image reference (tag = Coolify version), when the host reported one. */
  image: string | null;
  /** The newest applied Laravel migration name: the schema version. Null when the table or the row is absent. */
  schemaVersion: string | null;
  sections: Map<string, Row[]>;
  /** Sections this Coolify version does not have (their table is missing). */
  skipped: string[];
  /** Sections that returned as many rows as their cap: the read of them is incomplete. */
  truncated: string[];
  readAt: string;
}

const bound = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export function parseAgentRead(output: string, now: Date = new Date()): AgentRead {
  if (output.includes(CFY.noDocker)) throw new CoolifyReadError("no_docker");
  if (output.includes(CFY.noCoolify)) throw new CoolifyReadError("no_coolify");
  if (output.includes(CFY.stopped)) throw new CoolifyReadError("db_stopped");
  if (output.includes(CFYA.fail) || !output.includes(CFY.done)) throw new CoolifyReadError("unreadable");
  const ro = /^TUGRA_CFY_RO (.*)$/m.exec(output);
  if (!ro || ro[1].trim() !== "on") throw new CoolifyReadError("not_read_only");
  const iso = /^TUGRA_CFY_ISO (.*)$/m.exec(output);
  if (!iso || iso[1].trim() !== "repeatable read") throw new CoolifyReadError("not_read_only");

  const imageLine = /^TUGRA_CFY_IMAGE (.*)$/m.exec(output);
  const image = imageLine && imageLine[1].trim() ? bound(imageLine[1].trim(), 200) : null;

  const sections = new Map<string, Row[]>();
  const skipped: string[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(CFY.skip)) {
      skipped.push(line.slice(CFY.skip.length).trim());
    } else if (line.startsWith(CFY.begin)) {
      const name = line.slice(CFY.begin.length).trim();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && lines[j].trim() !== `${CFY.end}${name}`; j++) body.push(lines[j]);
      if (j >= lines.length) throw new CoolifyReadError("unreadable"); // no END marker: truncated output
      i = j;
      sections.set(name, strictRows(body.join("\n")));
    }
  }

  const limits = sectionLimits();
  // The query asks for one row more than the cap: more rows than the cap = cut. Exactly the cap (a one-row table at a cap of 1) is complete.
  const truncated: string[] = [];
  for (const [name, rows] of sections) {
    const cap = limits[name];
    if (cap === undefined) continue;
    if (rows.length > cap) {
      truncated.push(name);
      sections.set(name, rows.slice(0, cap));
    }
  }
  const migration = sections.get(SCHEMA_SECTION)?.[0]?.migration;
  return {
    image,
    schemaVersion: typeof migration === "string" && migration ? bound(migration, 200) : null,
    sections,
    skipped,
    truncated,
    readAt: now.toISOString(),
  };
}

function strictRows(text: string): Row[] {
  const t = text.trim();
  if (!t.startsWith("[")) throw new CoolifyReadError("unreadable");
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    throw new CoolifyReadError("unreadable");
  }
  if (!Array.isArray(v)) throw new CoolifyReadError("unreadable");
  return v.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
}
