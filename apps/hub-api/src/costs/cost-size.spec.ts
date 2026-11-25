import { providerFromHostname, providerHintOf, providerOf } from "./cost-size";

describe("providerFromHostname", () => {
  it("recognises a Contabo VPS by 'vmi' plus 6-9 digits", () => {
    expect(providerFromHostname("vmi2419591")).toBe("contabo");
    expect(providerFromHostname("VMI2419591")).toBe("contabo");
    expect(providerFromHostname("vmi123456")).toBe("contabo");
    expect(providerFromHostname("vmi123456789")).toBe("contabo");
    expect(providerFromHostname("vmi2419591.contaboserver.net")).toBe("contabo");
    expect(providerFromHostname("vmi2419591.local")).toBe("contabo");
  });

  it("does not guess from names that are not unambiguous", () => {
    expect(providerFromHostname("vmi12345")).toBeNull(); // 5 digits
    expect(providerFromHostname("vmi1234567890")).toBeNull(); // 10 digits
    expect(providerFromHostname("vmi2419591-web")).toBeNull();
    expect(providerFromHostname("myvmi2419591")).toBeNull();
    expect(providerFromHostname("vmi")).toBeNull();
    expect(providerFromHostname("web-1")).toBeNull();
    expect(providerFromHostname("ubuntu-s-1vcpu-1gb-fra1-01")).toBeNull();
    expect(providerFromHostname("")).toBeNull();
    expect(providerFromHostname(null)).toBeNull();
    expect(providerFromHostname(undefined)).toBeNull();
    expect(providerFromHostname("a".repeat(300))).toBeNull();
  });

  it("recognises a provider's own domain in a fully-qualified host name", () => {
    expect(providerFromHostname("vps-1a2b3c4d.vps.ovh.net")).toBe("ovh");
    expect(providerFromHostname("li123-45.members.linode.com")).toBe("linode");
    expect(providerFromHostname("x.fi-hel1.upcloud.host")).toBe("upcloud");
    expect(providerFromHostname("evil.ovh.net.example.com")).toBeNull();
  });
});

describe("providerHintOf", () => {
  it("prefers a link, then the agent's report, then the host name, and says which", () => {
    expect(providerHintOf({ provider: "vultr", cloudHint: "hetzner", hostname: "vmi2419591" })).toEqual({ provider: "vultr", hint: "linked" });
    expect(providerHintOf({ provider: null, cloudHint: "hetzner", hostname: "vmi2419591" })).toEqual({ provider: "hetzner", hint: "agent" });
    expect(providerHintOf({ provider: null, cloudHint: null, hostname: "vmi2419591" })).toEqual({ provider: "contabo", hint: "hostname" });
    expect(providerHintOf({ provider: null, cloudHint: null, hostname: "web-1" })).toBeNull();
    expect(providerHintOf({ provider: null, cloudHint: null })).toBeNull();
  });
  it("providerOf is the slug of that hint", () => {
    expect(providerOf({ provider: null, cloudHint: null, hostname: "vmi2419591" })).toBe("contabo");
    expect(providerOf({ provider: null, cloudHint: null })).toBeNull();
  });
});
