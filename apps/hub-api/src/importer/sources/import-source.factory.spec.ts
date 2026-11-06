import { ImportSourceFactory } from "./import-source.factory";
import { CoolifySource } from "./coolify.source";
import { DokploySource } from "./dokploy.source";

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
