/** A Kuma 1.x style backup (camelCase client export) with every monitor kind the importer maps. */
export const BACKUP = {
  version: "1.23.16",
  notificationList: [
    { id: 1, name: "Ops chat", active: 1, isDefault: 0, config: JSON.stringify({ type: "telegram", telegramBotToken: "123:abc", telegramChatID: "-100200", telegramMessageThreadID: "5" }) },
    { id: 2, name: "Hook", active: 1, config: JSON.stringify({ type: "webhook", webhookURL: "https://hooks.example.com/in", webhookContentType: "json", webhookAdditionalHeaders: "{\"X-Team\":\"acme\"}" }) },
    { id: 3, name: "Pager app", active: 1, config: JSON.stringify({ type: "PagerDuty", pagerdutyIntegrationKey: "k" }) },
    { id: 4, name: "Mail", active: 1, config: JSON.stringify({ type: "smtp", smtpHost: "smtp.example.com", smtpPort: 587, smtpSecure: false, smtpUsername: "u", smtpPassword: "p", smtpFrom: "a@example.com", smtpTo: "b@example.com" }) },
    { id: 5, name: "Broken", active: 1, config: JSON.stringify({ type: "discord" }) },
  ],
  monitorList: [
    {
      id: 10, name: "Website", type: "http", url: "https://example.com", method: "GET", interval: 60, retryInterval: 20, resendInterval: 3,
      maxretries: 2, timeout: 48, active: true, upsideDown: false, ignoreTls: true, maxredirects: 5,
      accepted_statuscodes: ["200-299", "401"], headers: "{\"Authorization\":\"Bearer s3cr3t\",\"Content-Length\":\"9\"}",
      body: null, authMethod: null, notificationIDList: { "1": true, "2": true, "3": true, "5": false },
    },
    {
      id: 11, name: "API", type: "http", url: "https://api.example.com/v1", method: "POST", interval: 30, retryInterval: 30, maxretries: 0,
      timeout: 10, active: true, accepted_statuscodes: ["200-299"], body: "{\"ping\":true}", authMethod: "basic",
      basic_auth_user: "svc", basic_auth_pass: "pw", notificationIDList: { "1": true },
    },
    { id: 12, name: "Status text", type: "keyword", url: "https://example.com/status", keyword: "OK", invertKeyword: true, interval: 120, maxretries: 1, accepted_statuscodes: ["200-299"], notificationIDList: {} },
    { id: 13, name: "Postgres", type: "port", hostname: "db.example.com", port: 5432, interval: 60, maxretries: 3, notificationIDList: { "4": true } },
    { id: 14, name: "Gateway", type: "ping", hostname: "gw.example.com", interval: 60, maxretries: 1, notificationIDList: {} },
    { id: 15, name: "MX", type: "dns", hostname: "example.com", dns_resolve_type: "MX", dns_resolve_server: "1.1.1.1", interval: 300, maxretries: 0, notificationIDList: {} },
    { id: 16, name: "Docker thing", type: "docker", interval: 60, notificationIDList: {} },
    { id: 17, name: "Group", type: "group", interval: 60, notificationIDList: {} },
    { id: 18, name: "Paused", type: "http", url: "https://paused.example.com", interval: 60, active: false, notificationIDList: {} },
    { id: 19, name: "Bad url", type: "http", url: "not a url", interval: 60, notificationIDList: {} },
    { id: 20, name: "Keyword empty", type: "keyword", url: "https://example.com", interval: 60, notificationIDList: {} },
    { id: 21, name: "SOA", type: "dns", hostname: "example.com", dns_resolve_type: "SOA", interval: 60, notificationIDList: {} },
    { id: 22, name: "NTLM site", type: "http", url: "https://ntlm.example.com", authMethod: "ntlm", expiryNotification: true, interval: 60, notificationIDList: {} },
  ],
};
