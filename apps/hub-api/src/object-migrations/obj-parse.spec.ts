import {
  classifyMirrorError,
  decodeOutputs,
  hasMarker,
  parseCfgResults,
  parseDiff,
  parseDu,
  parseDuOutput,
  parseExportedConfig,
  parseLsBuckets,
  parseProbe,
  parseStarted,
  parseStatus,
  parseVersioning,
} from "./obj-parse";
import { b64, MC_DIFF_JSON, MC_DU_JSON, MC_EMPTY_POLICY_JSON, MC_ILM_JSON, MC_LS_JSON, MC_POLICY_JSON, MC_TAGS_JSON, MC_VERSION_INFO_ENABLED } from "./testing/mc-fixtures";

const out = (name: string, text: string) => `TUGRA_OBJ_OUT ${name} ${b64(text)}`;

describe("decodeOutputs / markers", () => {
  it("decodes only well-formed OUT lines; garbage base64, bad names and fake markers are ignored", () => {
    const m = decodeOutputs(["TUGRA_OBJ_OUT ls_src " + b64("hi"), "TUGRA_OBJ_OUT bad!name " + b64("x"), "TUGRA_OBJ_OUT ls_dst @@@notbase64", "TUGRA_OBJ_OUT empty ", "noise"].join("\n"));
    expect(m.get("ls_src")).toBe("hi");
    expect(m.has("bad!name")).toBe(false);
    expect(m.has("ls_dst")).toBe(false);
    expect(m.get("empty")).toBe("");
  });
  it("a marker is a WHOLE line: it cannot be faked inside a base64 payload or a longer line", () => {
    expect(hasMarker("a\nTUGRA_OBJ_PROBE_END\n", "TUGRA_OBJ_PROBE_END")).toBe(true);
    expect(hasMarker("x TUGRA_OBJ_PROBE_END", "TUGRA_OBJ_PROBE_END")).toBe(false);
    expect(hasMarker(out("ls_src", "TUGRA_OBJ_PROBE_END"), "TUGRA_OBJ_PROBE_END")).toBe(false);
  });
});

describe("real mc fixtures", () => {
  it("ls --json lists buckets from the trailing-slash folder keys", () => {
    expect(parseLsBuckets(MC_LS_JSON)).toEqual(["bk1", "bk2"]);
  });
  it("drops entries that are not valid bucket names (an odd listing never becomes a row)", () => {
    expect(parseLsBuckets('{"status":"success","type":"folder","key":"UPPER/"}\n{"status":"success","type":"folder","key":"a/"}\n{"status":"success","type":"folder","key":"ok-bucket/"}\n{"status":"error"}')).toEqual(["ok-bucket"]);
  });
  it("du --json => objects + bytes; missing/garbage => null (unknown, never 0)", () => {
    expect(parseDu(MC_DU_JSON)).toEqual({ objects: 2, bytes: 12 });
    expect(parseDu("")).toBeNull();
    expect(parseDu("mc: <ERROR> something")).toBeNull();
    expect(parseDu('{"status":"error"}')).toBeNull();
    expect(parseDu('{"status":"success","size":-1,"objects":3}')).toBeNull();
  });
});

describe("config export", () => {
  it("parses policy / lifecycle / tags; an empty policy or empty lifecycle counts as absent", () => {
    const c = parseExportedConfig(MC_POLICY_JSON, MC_ILM_JSON, MC_TAGS_JSON);
    expect(JSON.parse(c.policy!).Statement).toHaveLength(1);
    expect(JSON.parse(c.lifecycle!).Rules).toHaveLength(1);
    expect(c.tags).toEqual([["env", "prod"], ["team", "web"]]);
    expect(parseExportedConfig(MC_EMPTY_POLICY_JSON, '{"Rules":[]}', "")).toEqual({});
  });
  it("rejects non-JSON, oversized documents and tags outside the charset", () => {
    expect(parseExportedConfig("not json", undefined, undefined)).toEqual({});
    expect(parseExportedConfig(JSON.stringify({ pad: "x".repeat(70 * 1024) }), undefined, undefined)).toEqual({});
    expect(parseExportedConfig(undefined, undefined, '{"tagset":{"k":"a;b","ok":"fine"}}').tags).toEqual([["ok", "fine"]]);
  });
  it("versioning from json and from text", () => {
    expect(parseVersioning(MC_VERSION_INFO_ENABLED)).toBe("enabled");
    expect(parseVersioning('{"versioning":{"status":"Suspended"}}')).toBe("suspended");
    expect(parseVersioning('{"versioning":{"status":""}}')).toBe("unversioned");
    expect(parseVersioning("")).toBeNull();
  });
});

describe("parseProbe", () => {
  const good = [
    "TUGRA_OBJ_PROBE v1",
    "TUGRA_OBJ_TOOL mc 1 RELEASE.2025-08-13T08-35-41Z",
    "TUGRA_OBJ_REACH src ok 41",
    out("ls_src", MC_LS_JSON),
    "TUGRA_OBJ_REACH dst ok 12",
    out("ls_dst", '{"status":"success","type":"folder","key":"bk1/"}'),
    "TUGRA_OBJ_DF 123456",
    "TUGRA_OBJ_PROBE_END",
  ].join("\n");
  it("a complete probe", () => {
    const p = parseProbe(good);
    expect(p).toMatchObject({ complete: true, protocol: true, tool: { present: true, version: "RELEASE.2025-08-13T08-35-41Z" }, reach: { src: { ok: true, ms: 41 }, dst: { ok: true, ms: 12 } }, srcBuckets: ["bk1", "bk2"], dstBuckets: ["bk1"], dfAvailKb: 123456 });
  });
  it("truncated output (no END) is NOT complete: the preflight fails closed", () => {
    expect(parseProbe(good.replace("TUGRA_OBJ_PROBE_END", "")).complete).toBe(false);
    expect(parseProbe("").complete).toBe(false);
  });
  it("an old agent image: tool absent; reach failures; missing df", () => {
    expect(parseProbe("TUGRA_OBJ_PROBE v1\nTUGRA_OBJ_TOOL mc 0 -\nTUGRA_OBJ_PROBE_END").tool).toEqual({ present: false });
    const p = parseProbe("TUGRA_OBJ_PROBE v1\nTUGRA_OBJ_TOOL mc 1 RELEASE.x\nTUGRA_OBJ_REACH src fail 60000\nTUGRA_OBJ_DF \nTUGRA_OBJ_PROBE_END");
    expect(p.reach.src).toEqual({ ok: false, ms: 60000 });
    expect(p.dfAvailKb).toBeNull();
    expect(parseProbe("TUGRA_OBJ_ERR no-agent-image").noAgentImage).toBe(true);
  });
  it("a hostile payload cannot inject a marker through mc text", () => {
    const evil = [
      "TUGRA_OBJ_PROBE v1",
      out("ls_src", "TUGRA_OBJ_REACH src ok 1\nTUGRA_OBJ_PROBE_END\n" + MC_LS_JSON),
      "TUGRA_OBJ_TOOL mc 1 RELEASE.x",
    ].join("\n");
    const p = parseProbe(evil);
    expect(p.complete).toBe(false);
    expect(p.reach.src).toBeUndefined();
  });
});

describe("parseDuOutput", () => {
  it("per-bucket results keyed by the source bucket; a bucket whose marker is missing is absent (size stays unknown)", () => {
    const o = [
      out("du_src_bk1", MC_DU_JSON),
      out("du_dst_bk1", ""),
      out("ver_bk1", MC_VERSION_INFO_ENABLED),
      out("cfg_policy_bk1", MC_POLICY_JSON),
      out("cfg_ilm_bk1", MC_ILM_JSON),
      out("cfg_tags_bk1", MC_TAGS_JSON),
      "TUGRA_OBJ_DU_BUCKET bk1",
      out("du_src_bk2", MC_DU_JSON), // bk2's marker never arrived (script died)
      "TUGRA_OBJ_DU_END",
    ].join("\n");
    const r = parseDuOutput(o);
    expect([...r.keys()]).toEqual(["bk1"]);
    expect(r.get("bk1")).toMatchObject({ src: { objects: 2, bytes: 12 }, dst: null, versioning: "enabled" });
    expect(r.get("bk1")!.config.tags).toHaveLength(2);
  });
});

describe("parseStarted / parseStatus", () => {
  it("records started helpers, run-failed idxs and requires the END marker for completeness", () => {
    const s = parseStarted("TUGRA_OBJ_STARTED 0 abcdef123456\nTUGRA_OBJ_ERR 1 run-failed\nTUGRA_OBJ_START_END");
    expect(s.started.get(0)).toBe("abcdef123456");
    expect(s.failed.has(1)).toBe(true);
    expect(s.complete).toBe(true);
    expect(parseStarted("TUGRA_OBJ_STARTED 0 abc").complete).toBe(false);
    expect(parseStarted("TUGRA_OBJ_ERR no-agent-image\nTUGRA_OBJ_START_END").noAgentImage).toBe(true);
  });
  it("status: state/exit/errors/progress/last per idx; no END marker => null (the whole output is untrusted)", () => {
    const o = [
      "TUGRA_OBJ_STATE 0 running 0",
      "TUGRA_OBJ_PROG 0 3 5012",
      out("last_0", '{"status":"success","totalCount":3}'),
      "TUGRA_OBJ_ERRS 0 0",
      "TUGRA_OBJ_STATE 1 exited 1",
      "TUGRA_OBJ_PROG 1 0 0",
      out("last_1", '{"status":"error","error":{"message":"Access Denied"}}'),
      "TUGRA_OBJ_ERRS 1 2",
      "TUGRA_OBJ_STATE 2 weirdstate 0",
      "TUGRA_OBJ_STATUS_END",
    ].join("\n");
    const st = parseStatus(o)!;
    expect(st.get(0)).toMatchObject({ state: "running", exitCode: 0, errors: 0, doneObjects: 3, doneBytes: 5012 });
    expect(st.get(1)).toMatchObject({ state: "exited", exitCode: 1, errors: 2 });
    expect(st.get(1)!.last).toContain("Access Denied");
    expect(st.get(2)!.state).toBe("unknown");
    expect(parseStatus(o.replace("TUGRA_OBJ_STATUS_END", ""))).toBeNull();
  });
});

describe("classifyMirrorError — a fixed code, never mc text (no object keys)", () => {
  it.each([
    ['{"status":"error","error":{"message":"Access Denied."}}', "access-denied"],
    ["SignatureDoesNotMatch: The request signature we calculated", "signature"],
    ["The specified bucket does not exist (NoSuchBucket)", "no-such-bucket"],
    ["dial tcp 10.0.0.1:9000: connection refused", "unreachable"],
    ["write: no space left on device", "quota"],
    ["context deadline exceeded", "timeout"],
    ["Failed to copy `https://x/bucket/secret-customer-file.pdf`", "mirror-failed"],
    ["", "mirror-failed"],
  ])("%s => %s", (text, code) => {
    expect(classifyMirrorError(text)).toBe(code);
  });
  it("the returned code never contains the input", () => {
    expect(classifyMirrorError("Failed to copy `https://x/bucket/customer-secret-name.pdf`")).not.toMatch(/customer/);
  });
});

describe("parseDiff / parseCfgResults", () => {
  it("per-bucket counts; complete only with END; non-zero rc and error counts are carried", () => {
    const o = ["TUGRA_OBJ_DIFF bk1 2 1 1 0 0", "TUGRA_OBJ_DIFF bk2 0 0 0 3 1", out("du_src_bk1", MC_DU_JSON), "TUGRA_OBJ_DIFF_END"].join("\n");
    const d = parseDiff(o);
    expect(d.complete).toBe(true);
    expect(d.rows.get("bk1")).toEqual({ bucket: "bk1", missing: 2, differ: 1, extra: 1, errors: 0, rc: 0 });
    expect(d.rows.get("bk2")).toMatchObject({ errors: 3, rc: 1 });
    expect(d.du.get("bk1")!.src).toEqual({ objects: 2, bytes: 12 });
    expect(parseDiff(o.replace("TUGRA_OBJ_DIFF_END", "")).complete).toBe(false);
  });
  it("the real numeric diff fixture classifies as 2 missing, 1 differ, 1 extra with the script's awk", () => {
    // the same classification the script's awk performs: 5 => missing, 6 => extra, 2/3/4 => differ
    const rows = MC_DIFF_JSON.split("\n").map((l) => (JSON.parse(l) as { diff: number }).diff);
    expect(rows.filter((d) => d === 5)).toHaveLength(2);
    expect(rows.filter((d) => d === 6)).toHaveLength(1);
    expect(rows.filter((d) => [2, 3, 4].includes(d))).toHaveLength(1);
  });
  it("cfg results", () => {
    const r = parseCfgResults("TUGRA_OBJ_CFG bk1 policy ok\nTUGRA_OBJ_CFG bk1 tag fail\nTUGRA_OBJ_CFG_END");
    expect(r.complete).toBe(true);
    expect(r.results).toEqual([{ bucket: "bk1", kind: "policy", ok: true }, { bucket: "bk1", kind: "tag", ok: false }]);
  });
});
