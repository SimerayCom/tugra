import { withServicePins } from "./migration-runs.service";
import { servicePinKey } from "../steps/import/baseline/image-pins";
import type { RunApplyInput } from "./dto";
import type { RunHint } from "../steps/import/baseline/run-hints";

const apply = (extra: Partial<RunApplyInput> = {}): RunApplyInput =>
  ({ sourceKind: "coolify", targetServerId: "srv-1", planHash: "a".repeat(32), ...extra }) as RunApplyInput;
const pin = (itemRef: string, member: string, value: string): RunHint =>
  ({ kind: "service-pin", key: servicePinKey(itemRef, member), scope: "run", value, evidence: {} }) as unknown as RunHint;

describe("withServicePins", () => {
  it("turns pinning back on for a stack whose choice disabled it, so a recorded pin takes effect", () => {
    const out = withServicePins(apply({ serviceChoices: { "service:s1": { pinImages: false } } } as Partial<RunApplyInput>), [pin("service:s1", "search", "getmeili/meilisearch:v1.51.0")]);
    expect(out.serviceChoices?.["service:s1"]).toMatchObject({ pinImages: true, pins: { search: "getmeili/meilisearch:v1.51.0" } });
  });

  it("leaves a skipped stack alone", () => {
    const out = withServicePins(apply({ serviceChoices: { "service:s1": { skip: true } } } as Partial<RunApplyInput>), [pin("service:s1", "search", "img:1")]);
    expect(out.serviceChoices?.["service:s1"]).toEqual({ skip: true });
  });
});
