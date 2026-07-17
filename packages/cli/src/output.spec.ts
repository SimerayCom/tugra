import { formatJson, formatTable } from "./output";

describe("output", () => {
  it("formats pretty JSON", () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("formats an aligned table with a header row", () => {
    const out = formatTable(
      [
        { id: "1", name: "alpha" },
        { id: "22", name: "b" },
      ],
      [
        { key: "id", header: "ID" },
        { key: "name", header: "NAME" },
      ],
    );
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^ID\s+NAME$/);
    expect(out).toContain("alpha");
    // columns are left-aligned to the widest cell
    expect(lines[1].startsWith("1 ")).toBe(true);
  });

  it("renders (none) for an empty result set", () => {
    expect(formatTable([], [{ key: "id", header: "ID" }])).toBe("(none)");
  });

  it("only renders the selected columns — a secret field never leaks", () => {
    const out = formatTable([{ id: "1", token: "tugra_pat_SECRET", password: "hunter2" }], [{ key: "id", header: "ID" }]);
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("hunter2");
  });

  it("degrades to (none) for a non-array input (a misbehaving hub response)", () => {
    expect(formatTable(undefined as unknown as never, [{ key: "id", header: "ID" }])).toBe("(none)");
    expect(formatTable("oops" as unknown as never, [{ key: "id", header: "ID" }])).toBe("(none)");
  });

  it("renders null/undefined cells as empty strings", () => {
    const out = formatTable([{ id: "1", ip: null }], [
      { key: "id", header: "ID" },
      { key: "ip", header: "IP" },
    ]);
    expect(out.split("\n")[1]).toBe("1");
  });
});
