import { ImportSourceFactory } from "./import-source.factory";
import { CoolifySource } from "./coolify.source";
import { DokploySource } from "./dokploy.source";
import { AgentCoolifySource } from "./agent-coolify.source";

describe("ImportSourceFactory", () => {
  const makeFactory = () => {
    const coolifyCreate = jest.fn(() => ({ get: jest.fn() }));
    const dokployCreate = jest.fn(() => ({ get: jest.fn() }));
    return { factory: new ImportSourceFactory({ create: coolifyCreate } as never, { create: dokployCreate } as never), coolifyCreate, dokployCreate };
  };

  it("builds a CoolifySource for the coolify kind, wiring the client with the baseUrl + token", () => {
    const { factory, coolifyCreate } = makeFactory();
    const src = factory.create("coolify", "https://c.example.com", "TOK");
    expect(src).toBeInstanceOf(CoolifySource);
    expect(src.kind).toBe("coolify");
    expect(coolifyCreate).toHaveBeenCalledWith("https://c.example.com", "TOK");
  });

  it("builds a DokploySource for the dokploy kind, wiring the client with the baseUrl + api key", () => {
    const { factory, dokployCreate } = makeFactory();
    const src = factory.create("dokploy", "https://d.example.com:3000", "KEY");
    expect(src).toBeInstanceOf(DokploySource);
    expect(src.kind).toBe("dokploy");
    expect(dokployCreate).toHaveBeenCalledWith("https://d.example.com:3000", "KEY");
  });

  it("builds the agent source for an agent session: a CoolifySource over the agent read, no HTTP client, no token", () => {
    const coolifyCreate = jest.fn();
    const reader = { read: jest.fn() };
    const factory = new ImportSourceFactory({ create: coolifyCreate } as never, { create: jest.fn() } as never, reader as never);
    const src = factory.createAgent("srv-agent");
    expect(src).toBeInstanceOf(AgentCoolifySource);
    expect(src).toBeInstanceOf(CoolifySource);
    expect(src.kind).toBe("coolify"); // sourceKind stays coolify: the transport is the session's business
    expect(coolifyCreate).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled(); // nothing is read until the source is used
  });

  it("refuses to build an agent source when no agent reader is wired", () => {
    expect(() => makeFactory().factory.createAgent("srv-agent")).toThrow(/not available/);
  });

  it("labels each kind for messages", () => {
    const { factory } = makeFactory();
    expect(factory.label("coolify")).toBe("Coolify");
    expect(factory.label("dokploy")).toBe("Dokploy");
  });

  it("throws on an unsupported source kind (so a new kind cannot be silently misrouted)", () => {
    const { factory } = makeFactory();
    expect(() => factory.create("bogus" as never, "https://x.example.com", "t")).toThrow(/unsupported import source/);
  });
});
