import { EMPTY_SAMPLE, comparePage, envRow, normalizeHtml, pageRow, pageTitle, redirectTarget, samplePage, summarize, tableDiffs, volumeRow, type PageSample } from "./verify-compare";

const ok = (over: Partial<PageSample> = {}): PageSample => ({ ...EMPTY_SAMPLE, status: 200, hash: "aa", bytes: 10, title: "Home", ...over });
const html = (body: string, status = 200) => samplePage({ status, contentType: "text/html", location: null, body: Buffer.from(body), truncated: false }, "app.example.com");

describe("normalizeHtml", () => {
  it("ignores what changes between two correct copies (scripts, nonces, comments, hidden fields, build ids)", () => {
    const a = `<html><head><title>Shop</title><script nonce="abc123">var t=1</script></head><body><!-- 2026-11-24 --><input type="hidden" name="csrf" value="x"><p>Hello   world</p><img src="/_next/static/Qm9rYWJ1aWxkaWQxMjM0NTY3OA/a.png"></body></html>`;
    const b = `<html><head><title>Shop</title><script nonce="zzz999">var t=2</script></head><body><!-- other --><input type="hidden" name="csrf" value="y"><p>Hello world</p><img src="/_next/static/ZmFrZWJ1aWxkaWQwMDAwMDAwMA/a.png"></body></html>`;
    expect(normalizeHtml(a)).toBe(normalizeHtml(b));
  });
  it("keeps real content differences", () => {
    expect(normalizeHtml("<p>Price 10</p>")).not.toBe(normalizeHtml("<p>Price 12</p>"));
  });
});

describe("pageTitle / redirectTarget", () => {
  it("reads and trims the title", () => expect(pageTitle("<title>\n  My  Shop \n</title>")).toBe("My Shop"));
  it("reduces a same-host redirect to its path and keeps a foreign one whole", () => {
    expect(redirectTarget("https://app.example.com/login?next=/", "app.example.com")).toBe("/login?next=/");
    expect(redirectTarget("/login", "app.example.com")).toBe("/login");
    expect(redirectTarget("https://sso.example.org/start", "app.example.com")).toBe("https://sso.example.org/start");
    expect(redirectTarget(null, "x.example.com")).toBeNull();
  });
});

describe("comparePage", () => {
  it("same status and same content is the same", () => expect(comparePage(ok(), ok())).toEqual({ verdict: "same", code: "same-content" }));
  it("hashes the normalized body, not the bytes", () => {
    const a = html(`<title>T</title><script>1</script><p>Hi</p>`);
    const b = html(`<title>T</title><script>2</script><p>Hi</p>`);
    expect(comparePage(a, b).verdict).toBe("same");
  });
  it("another status is a difference", () => expect(comparePage(ok(), ok({ status: 502, hash: null }))).toEqual({ verdict: "differs", code: "status" }));
  it("same title but another body is similar, another title is a difference", () => {
    expect(comparePage(ok({ hash: "a" }), ok({ hash: "b" }))).toEqual({ verdict: "similar", code: "content-close" });
    expect(comparePage(ok({ hash: "a" }), ok({ hash: "b", title: "Other" }))).toEqual({ verdict: "differs", code: "content" });
    expect(comparePage(ok({ hash: "a", title: null }), ok({ hash: "b", title: null })).verdict).toBe("differs");
  });
  it("redirects compare by destination", () => {
    const r = (location: string) => ok({ status: 301, hash: null, location });
    expect(comparePage(r("/a"), r("/a")).verdict).toBe("same");
    expect(comparePage(r("/a"), r("/b"))).toEqual({ verdict: "differs", code: "redirect" });
  });
  it("a side that did not answer is unknown, never a pass; both failing is a note", () => {
    expect(comparePage(ok(), { ...EMPTY_SAMPLE, error: "timeout" })).toEqual({ verdict: "unknown", code: "target-unreachable" });
    expect(comparePage({ ...EMPTY_SAMPLE, error: "unreachable" }, ok()).code).toBe("source-unreachable");
    expect(comparePage(ok(), { ...EMPTY_SAMPLE, error: "dark-proxy" }).code).toBe("same-host-needs-agent");
    expect(comparePage(ok({ status: 503 }), ok({ status: 503 }))).toEqual({ verdict: "similar", code: "both-failing" });
  });
  it("JSON bodies compare byte for byte", () => {
    const j = (b: string) => samplePage({ status: 200, contentType: "application/json", location: null, body: Buffer.from(b), truncated: false }, "x.example.com");
    expect(comparePage(j('{"a":1}'), j('{"a":1}')).verdict).toBe("same");
    expect(comparePage(j('{"a":1}'), j('{"a":2}')).verdict).toBe("differs");
  });
});

describe("tableDiffs", () => {
  it("lists the tables whose counts disagree, with a missing table as -1, sorted and capped", () => {
    expect(tableDiffs([{ name: "a", rows: 5 }, { name: "b", rows: 1 }, { name: "c", rows: 2 }], [{ name: "a", rows: 5 }, { name: "b", rows: 0 }, { name: "d", rows: 9 }])).toEqual([
      { name: "b", source: 1, target: 0 },
      { name: "c", source: 2, target: -1 },
      { name: "d", source: -1, target: 9 },
    ]);
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `t${String(i).padStart(2, "0")}`, rows: 1 }));
    expect(tableDiffs(many, [], 5)).toHaveLength(5);
  });
});

describe("volumeRow / envRow", () => {
  const v = { itemRef: "volume:_:x:data", name: "data", state: "DONE", entries: 12, rawBytesFinal: 100, rawBytesDone: 100 };
  it("a finished volume with matching bytes is the same; other bytes differ; unreported is unknown", () => {
    expect(volumeRow(v)).toMatchObject({ verdict: "same", files: 12, sourceBytes: 100, targetBytes: 100 });
    expect(volumeRow({ ...v, rawBytesDone: 90 })).toMatchObject({ verdict: "differs", code: "size" });
    expect(volumeRow({ ...v, rawBytesFinal: null })).toMatchObject({ verdict: "unknown" });
    expect(volumeRow({ ...v, state: "COPYING" })).toMatchObject({ verdict: "differs", code: "not-copied" });
  });
  it("env lists names the target lacks, never values; no gap is the same", () => {
    expect(envRow({ itemRef: "a", name: "api", targetKeys: 5, unresolved: ["DB_URL"], dropped: ["1BAD"] })).toMatchObject({ verdict: "differs", missing: [{ key: "DB_URL", reason: "unresolved" }, { key: "1BAD", reason: "invalid" }] });
    expect(envRow({ itemRef: "a", name: "api", targetKeys: 5, unresolved: [], dropped: [] }).verdict).toBe("same");
    expect(envRow({ itemRef: "a", name: "api", targetKeys: null, unresolved: [], dropped: [] }).verdict).toBe("unknown");
  });
  it("compares the source's variable names with the target's: a name only the source has is missing, extras on the target are fine", () => {
    const r = envRow({ itemRef: "a", name: "api", targetKeys: 3, unresolved: ["X"], dropped: [], sourceKeys: ["A", "B", "X", "Z"], targetKeyNames: ["A", "B", "EXTRA"] });
    expect(r.missing).toEqual([{ key: "X", reason: "unresolved" }, { key: "Z", reason: "missing" }]);
    expect(envRow({ itemRef: "a", name: "api", targetKeys: 2, unresolved: [], dropped: [], sourceKeys: ["A"], targetKeyNames: ["A", "EXTRA"] }).verdict).toBe("same");
    expect(envRow({ itemRef: "a", name: "api", targetKeys: 2, unresolved: [], dropped: [], sourceKeys: null, targetKeyNames: ["A"] }).verdict).toBe("same");
  });
});

describe("summarize", () => {
  const v = (verdict: "same" | "similar" | "differs" | "unknown") => ({ verdict });
  it("match only when every row is same or similar", () => {
    expect(summarize([v("same"), v("similar")]).state).toBe("match");
    expect(summarize([v("same"), v("unknown")]).state).toBe("incomplete");
    expect(summarize([v("unknown"), v("differs")]).state).toBe("differences");
    expect(summarize([]).state).toBe("incomplete");
  });
  it("counts each verdict", () => expect(summarize([v("same"), v("same"), v("differs")]).counts).toEqual({ checked: 3, same: 2, similar: 0, differs: 1, unknown: 0 }));
  it("a page row carries its verdict", () => expect(pageRow("h.example.com", "/", ok(), ok()).verdict).toBe("same"));
});
