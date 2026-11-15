jest.mock("node:dns", () => ({ promises: { resolve4: jest.fn(), resolve6: jest.fn(), resolveCname: jest.fn(), resolveNs: jest.fn(), Resolver: jest.fn() } }));
import { promises as dns } from "node:dns";
import { DnsLookupService } from "./dns-lookup.service";

const mockDns = dns as jest.Mocked<typeof dns>;
const svc = new DnsLookupService();

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("DnsLookupService", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns the resolved A records", async () => {
    (mockDns.resolve4 as jest.Mock).mockResolvedValue(["203.0.113.7"]);
    await expect(svc.resolve4("example.com")).resolves.toEqual(["203.0.113.7"]);
  });

  it("treats a not-yet-propagated name (ENOTFOUND/ENODATA/NXDOMAIN) as an empty result, not an error", async () => {
    for (const code of ["ENOTFOUND", "ENODATA", "NXDOMAIN"]) {
      (mockDns.resolve6 as jest.Mock).mockRejectedValueOnce(errno(code));
      await expect(svc.resolve6("example.com")).resolves.toEqual([]);
    }
  });

  it("rethrows a real resolver failure (e.g. SERVFAIL)", async () => {
    (mockDns.resolve4 as jest.Mock).mockRejectedValue(errno("SERVFAIL"));
    await expect(svc.resolve4("example.com")).rejects.toThrow("SERVFAIL");
  });
});

describe("DnsLookupService cutover lookups", () => {
  afterEach(() => jest.resetAllMocks());

  /** A fake Resolver class: each instance remembers the servers it was pointed at and answers from `answers`. */
  function fakeResolvers(answers: Record<string, string[] | Error>, ttl = 300) {
    const made: Array<{ servers: string[] }> = [];
    (mockDns.Resolver as unknown as jest.Mock).mockImplementation(() => {
      const inst = { servers: [] as string[], setServers(s: string[]) { this.servers = s; }, resolve4: jest.fn(), resolve6: jest.fn() };
      const answer = async (_h: string, o?: { ttl?: boolean }) => {
        const a = answers[inst.servers[0]];
        if (a instanceof Error) throw a;
        const list = a ?? [];
        return o?.ttl ? list.map((address) => ({ address, ttl })) : list;
      };
      inst.resolve4.mockImplementation(answer);
      inst.resolve6.mockImplementation(async () => []);
      made.push(inst);
      return inst;
    });
    return made;
  }

  it("resolveWithTtl returns addresses with the system resolver's TTL", async () => {
    (mockDns.resolve4 as jest.Mock).mockResolvedValue([{ address: "1.1.1.1", ttl: 17 }]);
    await expect(svc.resolveWithTtl("a.com", "A")).resolves.toEqual([{ address: "1.1.1.1", ttl: 17 }]);
    expect(mockDns.resolve4).toHaveBeenCalledWith("a.com", { ttl: true });
  });

  it("resolveAuthoritative walks the labels up to the NS set, then asks the nameservers themselves", async () => {
    (mockDns.resolveNs as jest.Mock).mockImplementation(async (name: string) => {
      if (name === "example.com") return ["ns1.cf.net"];
      throw errno("ENODATA");
    });
    (mockDns.resolve4 as jest.Mock).mockImplementation(async (name: string) => (name === "ns1.cf.net" ? ["173.245.58.1"] : []));
    fakeResolvers({ "173.245.58.1": ["203.0.113.7"] }, 120);
    const r = await svc.resolveAuthoritative("deep.app.example.com", "A");
    expect(r).toEqual({ addresses: ["203.0.113.7"], ttl: 120, ns: ["ns1.cf.net"] });
    expect((mockDns.resolveNs as jest.Mock).mock.calls.map((c) => c[0])).toEqual(["deep.app.example.com", "app.example.com", "example.com"]);
  });

  it("resolveAuthoritative reports nothing when no NS set exists", async () => {
    (mockDns.resolveNs as jest.Mock).mockRejectedValue(errno("ENODATA"));
    await expect(svc.resolveAuthoritative("a.example.com", "A")).resolves.toEqual({ addresses: [], ttl: null, ns: [] });
  });

  it("resolvePublic asks 1.1.1.1, 8.8.8.8 and 9.9.9.9; a resolver that fails counts as 'not seen yet'", async () => {
    fakeResolvers({ "1.1.1.1": ["203.0.113.7"], "8.8.8.8": errno("ETIMEOUT"), "9.9.9.9": ["198.51.100.1"] });
    await expect(svc.resolvePublic("a.com", "A")).resolves.toEqual({ "1.1.1.1": ["203.0.113.7"], "8.8.8.8": [], "9.9.9.9": ["198.51.100.1"] });
  });
});
