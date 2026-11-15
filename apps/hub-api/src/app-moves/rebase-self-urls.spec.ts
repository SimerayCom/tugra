import { rebaseSelfUrls, replaceIpToken } from "./rebase-self-urls";

describe("replaceIpToken — exact IP tokens only", () => {
  it.each([
    ["http://10.0.0.12:8080/x", "10.0.0.12", "5.6.7.8", "http://5.6.7.8:8080/x"],
    ["10.0.0.12", "10.0.0.12", "5.6.7.8", "5.6.7.8"],
    ["a=10.0.0.12,b=10.0.0.12", "10.0.0.12", "5.6.7.8", "a=5.6.7.8,b=5.6.7.8"],
    // substrings of longer addresses must NOT match
    ["10.0.0.123", "10.0.0.12", "5.6.7.8", "10.0.0.123"],
    ["110.0.0.12", "10.0.0.12", "5.6.7.8", "110.0.0.12"],
    ["10.0.0.12.5", "10.0.0.12", "5.6.7.8", "10.0.0.12.5"],
    ["v10.0.0.12", "10.0.0.12", "5.6.7.8", "v5.6.7.8"], // a letter is not part of an IP token
    // regex metacharacters in the ip are literal (the dots are not wildcards)
    ["10x0x0x12", "10.0.0.12", "5.6.7.8", "10x0x0x12"],
    // ipv6 is bounded by hex digits and colons
    ["http://[2001:db8::1]:80", "2001:db8::1", "2001:db8::2", "http://[2001:db8::2]:80"],
    ["2001:db8::12", "2001:db8::1", "2001:db8::2", "2001:db8::12"],
  ])("%s", (text, from, to, want) => {
    expect(replaceIpToken(text, from, to)).toBe(want);
  });
});

describe("rebaseSelfUrls", () => {
  const from = { ip: "1.2.3.4", domain: "blog-ab12cd.1-2-3-4.sslip.io" };
  const to = { ip: "5.6.7.8", domain: "blog-ab12cd.5-6-7-8.sslip.io" };

  it("rewrites the old magic domain AND the server ip in the compose file", () => {
    const composeFile = `services:\n  web:\n    environment:\n      SITE_URL: http://${from.domain}\n      DB_HOST: ${from.ip}\n`;
    const r = rebaseSelfUrls({ composeFile, configMounts: null }, from, to);
    expect(r.changed).toBe(true);
    expect(r.composeFile).toContain(`http://${to.domain}`);
    expect(r.composeFile).toContain(`DB_HOST: ${to.ip}`);
    expect(r.composeFile).not.toContain(from.domain);
  });

  it("rewrites config mount contents and keeps every other mount field", () => {
    const mounts = [
      { service: "web", target: "/etc/a.conf", content: `server_name ${from.domain};\nlisten ${from.ip}:80;` },
      { service: "web", target: "/etc/b.conf", content: "untouched" },
      { service: "web", target: "/etc/c.bin" },
    ];
    const r = rebaseSelfUrls({ composeFile: null, configMounts: mounts }, from, to);
    expect(r.changed).toBe(true);
    const out = r.configMounts as typeof mounts;
    expect(out[0]).toEqual({ service: "web", target: "/etc/a.conf", content: `server_name ${to.domain};\nlisten ${to.ip}:80;` });
    expect(out[1]).toBe(mounts[1]);
    expect(out[2]).toBe(mounts[2]);
  });

  it("is a no-op when the addresses are unknown or equal", () => {
    const composeFile = `url: http://${from.domain} ip ${from.ip}`;
    expect(rebaseSelfUrls({ composeFile, configMounts: null }, { ip: null, domain: null }, to)).toMatchObject({ changed: false, composeFile });
    expect(rebaseSelfUrls({ composeFile, configMounts: null }, from, { ip: null, domain: null })).toMatchObject({ changed: false, composeFile });
    expect(rebaseSelfUrls({ composeFile, configMounts: null }, from, from)).toMatchObject({ changed: false, composeFile });
  });

  it("rewrites the domain even when only the domain is known on both sides (ip untouched)", () => {
    const composeFile = `a: ${from.domain}\nb: ${from.ip}`;
    const r = rebaseSelfUrls({ composeFile, configMounts: null }, { ip: null, domain: from.domain }, { ip: null, domain: to.domain });
    expect(r.composeFile).toBe(`a: ${to.domain}\nb: ${from.ip}`);
  });

  it("does not corrupt a compose that merely contains a longer address", () => {
    const composeFile = "subnet: 1.2.3.45/24\nhost: 11.2.3.4\n";
    const r = rebaseSelfUrls({ composeFile, configMounts: null }, from, to);
    expect(r.changed).toBe(false);
    expect(r.composeFile).toBe(composeFile);
  });

  it("handles null composeFile / non-array configMounts", () => {
    expect(rebaseSelfUrls({ composeFile: null, configMounts: null }, from, to)).toEqual({ composeFile: null, configMounts: null, changed: false });
    expect(rebaseSelfUrls({ composeFile: null, configMounts: "x" }, from, to).changed).toBe(false);
  });
});
