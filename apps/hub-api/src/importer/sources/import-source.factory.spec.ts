import { ImportSourceFactory } from "./import-source.factory";
import { CoolifySource } from "./coolify.source";

describe("ImportSourceFactory", () => {
  const makeFactory = () => {
    const create = jest.fn(() => ({ get: jest.fn() }));
    return { factory: new ImportSourceFactory({ create } as never), create };
  };

  it("builds a CoolifySource for the coolify kind, wiring the client with the baseUrl + token", () => {
    const { factory, create } = makeFactory();
    const src = factory.create("coolify", "https://c.example.com", "TOK");
    expect(src).toBeInstanceOf(CoolifySource);
    expect(src.kind).toBe("coolify");
    expect(create).toHaveBeenCalledWith("https://c.example.com", "TOK");
  });

  it("labels coolify as Coolify", () => {
    expect(makeFactory().factory.label("coolify")).toBe("Coolify");
  });

  it("throws on an unsupported source kind (so a new kind cannot be silently misrouted)", () => {
    const { factory } = makeFactory();
    expect(() => factory.create("bogus" as never, "https://x.example.com", "t")).toThrow(/unsupported import source/);
  });
});
