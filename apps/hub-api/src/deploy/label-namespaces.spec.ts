import { RESERVED_LABEL_PREFIXES, reservedLabelNamespace } from "./label-namespaces";

describe("reservedLabelNamespace", () => {
  it("matches every reserved prefix", () => {
    for (const p of RESERVED_LABEL_PREFIXES) expect(reservedLabelNamespace(`${p}x`)).toBe(p);
  });
  it("is case-insensitive and trims whitespace", () => {
    expect(reservedLabelNamespace("TRAEFIK.enable")).toBe("traefik.");
    expect(reservedLabelNamespace("  Tugra.role")).toBe("tugra.");
    expect(reservedLabelNamespace("COM.Docker.Compose.project")).toBe("com.docker.compose.");
  });
  it("respects the prefix boundary", () => {
    expect(reservedLabelNamespace("traefikish")).toBeNull();
    expect(reservedLabelNamespace("traefik")).toBeNull();
    expect(reservedLabelNamespace("tugrax.y")).toBeNull();
    expect(reservedLabelNamespace("com.docker.extension.x")).toBeNull();
    expect(reservedLabelNamespace("com.docker.compose")).toBeNull();
    expect(reservedLabelNamespace("org.opencontainers.image.title")).toBeNull();
    expect(reservedLabelNamespace("team")).toBeNull();
  });
});
