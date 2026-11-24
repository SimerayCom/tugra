import { HexColorSchema, SetColorSchema } from "./hex-color";

describe("hex colour schema", () => {
  it("normalises to lower case", () => {
    expect(HexColorSchema.parse("#A1B2C3")).toBe("#a1b2c3");
  });

  it.each(["#fff", "red", "a1b2c3", "#a1b2c", "#a1b2c3d", "rgb(1,2,3)", "#gggggg", ""])("rejects %j", (v) => {
    expect(HexColorSchema.safeParse(v).success).toBe(false);
  });

  it("accepts null to clear the colour", () => {
    expect(SetColorSchema.parse({ color: null })).toEqual({ color: null });
    expect(SetColorSchema.parse({ color: "#00FF00" })).toEqual({ color: "#00ff00" });
  });

  it("requires the colour key", () => {
    expect(SetColorSchema.safeParse({}).success).toBe(false);
  });
});
