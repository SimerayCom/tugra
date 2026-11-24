"use client";

import { useT } from "../i18n/provider";
import { MoreInfo } from "./help-link";
import { guideUrl } from "../lib/help-links";

/**
 * "Can't reach the server?": the four ways to run the install command when SSH is not straightforward (port 22 closed or limited to
 * one address, a jump host, only a provider console, or a server that is not created yet), one line each, behind a closed
 * disclosure. The long version lives in the Add a server guide.
 */
export function ServerAccessHelp() {
  const t = useT();
  return (
    <MoreInfo label={t("servers.access.title")} style={{ margin: "10px 0 0" }}>
      <ul data-testid="server-access-help" style={{ margin: "0 0 6px", paddingLeft: 16 }}>
        <li>{t("servers.access.ssh")}</li>
        <li>{t("servers.access.jump")}</li>
        <li>{t("servers.access.console")}</li>
        <li>{t("servers.access.cloudInit")}</li>
      </ul>
      <p style={{ margin: "0 0 6px" }}>{t("servers.access.outbound")}</p>
      <a href={guideUrl("add-a-server")} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t("servers.access.guide")}</a>
    </MoreInfo>
  );
}
