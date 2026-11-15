import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import apps from "./locales/en/apps.json";
import servers from "./locales/en/servers.json";

const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

function lookup(tree: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
}

// Every file that renders file-manager UI text.
const FILES = [
  "components/app-files-card.tsx",
  "components/app-file-dialogs.tsx",
  "components/app-file-editor.tsx",
  "components/app-file-uploads.tsx",
  "lib/files-api.ts",
];

describe("file manager i18n coverage", () => {
  it("every literal apps.files.* key used in code exists in en/apps.json", () => {
    const used = new Set<string>();
    for (const f of FILES) for (const m of read(f).matchAll(/["'`](apps\.files\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    // keys are addressed under the apps namespace: "apps.files.x" => apps.json files.x
    const missing = [...used].filter((k) => typeof lookup(apps, k.replace(/^apps\./, "")) !== "string");
    expect(missing).toEqual([]);
  });

  it("the dynamic keys (permission rows/columns, error codes) all exist", () => {
    for (const k of ["owner", "group", "other", "read", "write", "exec"]) expect(typeof lookup(apps, `files.${k}`)).toBe("string");
    const src = read("lib/files-api.ts");
    const known = /const KNOWN = new Set\(\[([\s\S]*?)\]\)/.exec(src)![1].match(/"([a-z_]+)"/g)!.map((s) => s.replace(/"/g, ""));
    expect(known.length).toBeGreaterThan(20);
    for (const code of known) expect(typeof lookup(apps, `files.err.${code}`), `files.err.${code}`).toBe("string");
  });

  it("covers every closed agent error code from @tugra/shared plus the hub's own codes", () => {
    // The web does not link @tugra/shared, so read the closed list straight from its source: a new agent code with no
    // translation fails here instead of showing a raw code to a user.
    const shared = readFileSync(path.resolve(SRC, "../../../packages/shared/src/index.ts"), "utf8");
    const FS_ERROR_CODES = /FS_ERROR_CODES = \[([\s\S]*?)\] as const/.exec(shared)![1].match(/"([a-z_]+)"/g)!.map((x) => x.replace(/"/g, ""));
    expect(FS_ERROR_CODES.length).toBe(20);
    for (const code of FS_ERROR_CODES) expect(typeof lookup(apps, `files.err.${code}`), `files.err.${code}`).toBe("string");
    for (const code of ["rate_limited", "capability_not_granted", "agent_too_old", "datastore_running", "deploy_in_progress"]) {
      expect(typeof lookup(apps, `files.err.${code}`), `files.err.${code}`).toBe("string");
    }
  });

  it("the spec'd file-manager keys are all present", () => {
    const keys = ("refresh upload uploadHint dropHere newFile newFolder nameLabel nameInvalid download edit save saved cancel discard unsaved rename renameTo permissions modeLabel modeHint owner group other read write exec delete deleteFile deleteDir deleteTypeName overwrite skip overwriteBody retry reload overwriteAnyway sourceVolumes sourceContainer containerPicker pathField quickLinks containerEphemeral containerTruncated containerNoBinary binaryNoEdit tooBigNoEdit lineEndingsNoEdit changedOnDisk queueTitle queueRetrying queueUploading queueApplying queueDone queueFailed queueTooLarge datastoreWarn datastoreAck capOff capOffLink writeCapOff writeCapHint terminalCapOff terminalPermOff agentOld offline deployInProgress clustered notDeployed").split(" ");
    for (const k of keys) expect(typeof lookup(apps, `files.${k}`), `files.${k}`).toBe("string");
    expect(lookup(apps, "files.desc")).not.toMatch(/read-only/i); // the description is neutral now that the card can write
    for (const k of ["cap_files", "cap_files_desc", "cap_files_write", "cap_files_write_desc"]) expect(typeof (servers as Record<string, unknown>)[k], k).toBe("string");
  });

  it("the servers capability card uses only keys that exist", () => {
    const src = read("components/server-capabilities-card.tsx");
    expect(src).toContain("servers.cap_${c}");
    for (const c of ["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch", "logs", "files", "files_write", "swarm"]) {
      expect(typeof (servers as Record<string, unknown>)[`cap_${c}`], `cap_${c}`).toBe("string");
    }
  });

  it("no hardcoded English UI strings slipped into the new components (every visible label goes through t())", () => {
    for (const f of ["components/app-file-dialogs.tsx", "components/app-file-editor.tsx", "components/app-file-uploads.tsx"]) {
      const jsxText = [...read(f).matchAll(/<[A-Za-z][^<>]*>\s*([A-Z][a-z]+(?: [a-z]+)*)\s*<\//g)].map((m) => m[1]);
      expect(jsxText, f).toEqual([]);
    }
    expect(readdirSync(path.join(SRC, "i18n/locales")).length).toBeGreaterThan(0);
  });
});
