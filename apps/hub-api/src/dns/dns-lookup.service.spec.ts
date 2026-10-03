jest.mock("node:dns", () => ({ promises: { resolve4: jest.fn(), resolve6: jest.fn(), resolveCname: jest.fn() } }));
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
