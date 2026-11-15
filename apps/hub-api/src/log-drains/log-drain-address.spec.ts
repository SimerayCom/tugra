import { classifyHost, v6Bytes } from "./log-drain-address";

describe("classifyHost (hub literal-address pre-check)", () => {
  it.each([
    ["169.254.169.254", "blocked"],
    ["169.254.0.1", "blocked"],
    ["0.0.0.0", "blocked"],
    ["0.1.2.3", "blocked"],
    ["224.0.0.1", "blocked"],
    ["::", "blocked"],
    ["fe80::1", "blocked"],
    ["febf::1", "blocked"],
    ["fd00:ec2::254", "blocked"],
    ["ff02::1", "blocked"],
    ["::ffff:169.254.169.254", "blocked"], // v4-mapped metadata
    ["::ffff:0.0.0.0", "blocked"],
    ["[::ffff:a9fe:a9fe]", "blocked"], // v4-mapped, hex form, bracketed
    ["64:ff9b::169.254.169.254", "blocked"], // NAT64-embedded
    ["metadata.google.internal", "blocked"],
    ["Metadata.Google.Internal.", "blocked"],
  ])("%s is always blocked", (h, want) => expect(classifyHost(h)).toBe(want));

  it.each([
    "127.0.0.1", "127.9.9.9", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255",
    "::1", "fc00::1", "fdab::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "localhost", "LOCALHOST", "db.localhost",
  ])("%s is private", (h) => expect(classifyHost(h)).toBe("private"));

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700::1111", "[2001:db8::1]"])("%s is public", (h) =>
    expect(classifyHost(h)).toBe("public"),
  );

  it.each(["logs.example.com", "syslog", "a.b.c"])("%s is a name (resolved agent-side)", (h) => expect(classifyHost(h)).toBe("name"));

  it("expands IPv6 forms into 16 bytes", () => {
    expect(v6Bytes("::1")).toEqual([...new Array(15).fill(0), 1]);
    expect(v6Bytes("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4]);
    expect(v6Bytes("1:2:3:4:5:6:7:8")).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
    expect(v6Bytes("fe80::")?.slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(v6Bytes("not-ip")).toBeNull();
    expect(v6Bytes("1.2.3.4")).toBeNull();
  });
});
