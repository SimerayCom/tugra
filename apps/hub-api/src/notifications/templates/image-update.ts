import { base, fields, s, type EventTemplate } from "../event";

/** "sha256:<hex>" (or bare hex) → its first 12 hex chars. Anything else (empty / odd) renders as given, capped. */
function shortDigest(v: string): string {
  const m = /^(?:sha256:)?([0-9a-f]{12,64})$/.exec(v);
  return m ? m[1]!.slice(0, 12) : v.slice(0, 19);
}

/** image_update_available — the upstream registry moved the tag of an IMAGE app's image past the deployed digest. */
export const imageUpdateTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const app = s(c, "appName");
    const image = s(c, "image");
    const appId = s(c, "appId");
    return base(ev, {
      level: "info",
      title: env.t("imageUpdate.title", { app }),
      summary: env.t("imageUpdate.summary", { image }),
      fields: fields([
        { label: env.t("imageUpdate.field.app"), value: app, inline: true },
        { label: env.t("imageUpdate.field.image"), value: image, inline: true },
        { label: env.t("imageUpdate.field.deployed"), value: shortDigest(s(c, "deployedDigest")), inline: true },
        { label: env.t("imageUpdate.field.upstream"), value: shortDigest(s(c, "upstreamDigest")), inline: true },
        { label: env.t("imageUpdate.field.project"), value: s(c, "projectName"), inline: true },
        { label: env.t("imageUpdate.field.environment"), value: s(c, "environmentName"), inline: true },
      ]),
      links: appId ? [{ label: env.t("imageUpdate.link.openApp"), url: `${env.webBaseUrl}/apps/${appId}` }] : [],
    });
  },
};
