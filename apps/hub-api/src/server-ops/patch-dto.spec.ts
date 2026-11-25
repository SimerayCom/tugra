import { FleetPatchApplySchema, PatchApplyBodySchema, PatchApplySchema } from "./dto";

describe("patch apply DTOs", () => {
  it("scope defaults to the full update, so existing API callers are unchanged", () => {
    expect(PatchApplySchema.parse({})).toEqual({ scope: "all" });
    expect(FleetPatchApplySchema.parse({ serverIds: ["s1"] })).toEqual({ serverIds: ["s1"], scope: "all" });
  });

  it("a POST without a body is the full update", () => {
    expect(PatchApplyBodySchema.parse(undefined)).toEqual({ scope: "all" });
    expect(PatchApplyBodySchema.parse({ scope: "except-engine" })).toEqual({ scope: "except-engine" });
  });

  it("accepts except-engine and rejects anything else", () => {
    expect(PatchApplySchema.parse({ scope: "except-engine" })).toEqual({ scope: "except-engine" });
    expect(FleetPatchApplySchema.parse({ serverIds: ["s1"], scope: "except-engine" }).scope).toBe("except-engine");
    expect(PatchApplySchema.safeParse({ scope: "everything" }).success).toBe(false);
    expect(FleetPatchApplySchema.safeParse({ serverIds: ["s1"], scope: "docker-ce; reboot" }).success).toBe(false);
  });
});
