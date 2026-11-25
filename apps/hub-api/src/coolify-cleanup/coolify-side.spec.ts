import { withHostVolumes } from "./coolify-side";
import type { CoolifySide } from "./completeness";

const UA = "uuidapp1uuidapp1uuidapp1";
const UD = "uuiddb001uuiddb001uuiddb";
const US = "uuidsvc01uuidsvc01uuidsv";
const side = (over: Partial<CoolifySide> = {}): CoolifySide => ({
  applications: [{ ref: UA, uuid: UA, name: "blog", envKeys: 0, domains: [], volumes: null, running: false }],
  databases: [{ ref: UD, uuid: UD, name: "main-db", envKeys: 0, volumes: null, running: false }],
  services: [{ ref: US, uuid: US, name: "plausible", envKeys: 0, volumes: null, running: false }],
  tasks: [],
  backups: [],
  notifications: [],
  ...over,
});
const c = (name: string, state = "running") => ({ name, image: "x", state, managed: true });

describe("withHostVolumes", () => {
  it("takes a database's volumes from the host by their <name>-<uuid> name, and an app's or service's by <uuid>-<name>", () => {
    const out = withHostVolumes(side(), [`postgres-data-${UD}`, `${UA}-data`, `${US}_pg`, "unrelated", `${UD}x-data`]);
    expect(out.databases[0].volumes).toEqual([`postgres-data-${UD}`]);
    expect(out.applications[0].volumes).toEqual([`${UA}-data`]);
    expect(out.services[0].volumes).toEqual([`${US}_pg`]);
  });

  it("a database with a running container and no volume found is unreadable (null), not vacuously empty", () => {
    const out = withHostVolumes(side(), [], [c(UD)]);
    expect(out.databases[0].volumes).toBeNull();
    expect(out.databases[0].running).toBe(true);
  });

  it("a database stopped on the host and without volumes, or an app without volumes, has none", () => {
    const out = withHostVolumes(side(), [], [c(UD, "exited"), c(`${UA}-1`)]);
    expect(out.databases[0].volumes).toEqual([]);
    expect(out.applications[0].volumes).toEqual([]);
  });

  it("a volume list the stored read already carries is used as it is", () => {
    const s = side({ databases: [{ ref: UD, uuid: UD, name: "main-db", envKeys: 0, volumes: ["mine"], running: false }] });
    expect(withHostVolumes(s, [`postgres-data-${UD}`], [c(UD)]).databases[0].volumes).toEqual(["mine"]);
  });

  it("the running state comes from the host: a service with a running component container is running, a stopped one is not", () => {
    expect(withHostVolumes(side(), [], [c(`plausible-${US}`)]).services[0].running).toBe(true);
    expect(withHostVolumes(side(), [], [c(`plausible-${US}`, "exited")]).services[0].running).toBe(false);
    expect(withHostVolumes(side(), [], []).services[0].running).toBe(false);
    // running in the stored read stays running
    expect(withHostVolumes(side({ applications: [{ ref: UA, uuid: UA, name: "blog", envKeys: 0, domains: [], volumes: [], running: true }] }), [], []).applications[0].running).toBe(true);
  });
});
