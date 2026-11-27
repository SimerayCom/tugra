/**
 * A CapRover `appDefinitions` answer, shaped like the live API (`GET /api/v2/user/apps/appDefinitions`). Every secret in it is a
 * SENTINEL string: the specs assert none of them ever reaches a discovered fleet.
 */
export const CAPROVER_SENTINELS = ["GHOSTPW_SENTINEL", "GITPW_SENTINEL", "SSHKEY_SENTINEL", "DBPW_SENTINEL", "HTTPPW_SENTINEL", "SESSION_TOKEN_SENTINEL"];

export const caproverDefinitions = (): Array<Record<string, unknown>> => [
  {
    appName: "blog",
    instanceCount: 1,
    hasPersistentData: true,
    notExposeAsWebApp: false,
    containerHttpPort: 2368,
    forceSsl: true,
    websocketSupport: false,
    hasDefaultSubDomainSsl: true,
    captainDefinitionRelativeFilePath: "./captain-definition",
    envVars: [
      { key: "url", value: "https://blog.example.com" },
      { key: "database__connection__password", value: "GHOSTPW_SENTINEL" },
    ],
    volumes: [{ containerPath: "/var/lib/ghost/content", volumeName: "blog-content" }],
    ports: [],
    customDomain: [{ publicDomain: "blog.example.com", hasSsl: true }],
    deployedVersion: 2,
    versions: [
      { version: 1, deployedImageName: "ghost:5.1", timeStamp: "2026-01-01T00:00:00Z" },
      { version: 2, deployedImageName: "ghost:5.2", timeStamp: "2026-02-01T00:00:00Z" },
    ],
  },
  {
    appName: "api",
    instanceCount: 3,
    hasPersistentData: false,
    notExposeAsWebApp: false,
    containerHttpPort: 3000,
    forceSsl: false,
    captainDefinitionRelativeFilePath: "./captain-definition",
    envVars: [
      { key: "DATABASE_URL", value: "postgres://app:DBPW_SENTINEL@srv-captain--db:5432/app" },
      { key: "CACHE_HOST", value: "srv-captain--cache" },
      { key: "NODE_ENV", value: "production" },
    ],
    volumes: [],
    ports: [{ containerPort: 9000, hostPort: 9000 }],
    customDomain: [
      { publicDomain: "api.example.com", hasSsl: true },
      { publicDomain: "api.example.org", hasSsl: false },
    ],
    customNginxConfig: "location /x { return 204; }",
    appPushWebhook: { repoInfo: { repo: "github.com/acme/api", branch: "main", user: "ci", password: "GITPW_SENTINEL", sshKey: "SSHKEY_SENTINEL" } },
    deployedVersion: 7,
    versions: [{ version: 7, deployedImageName: "img-captain--api:7" }],
  },
  {
    appName: "db",
    instanceCount: 1,
    hasPersistentData: true,
    notExposeAsWebApp: true,
    envVars: [
      { key: "POSTGRES_USER", value: "app" },
      { key: "POSTGRES_PASSWORD", value: "DBPW_SENTINEL" },
      { key: "POSTGRES_DB", value: "app" },
    ],
    volumes: [{ containerPath: "/var/lib/postgresql/data", volumeName: "db-data" }],
    ports: [{ containerPort: 5432, hostPort: 5432 }],
    customDomain: [],
    deployedVersion: 1,
    versions: [{ version: 1, deployedImageName: "postgres:16-alpine" }],
  },
  {
    appName: "cache",
    instanceCount: 1,
    notExposeAsWebApp: true,
    envVars: [],
    volumes: [],
    ports: [],
    customDomain: [],
    deployedVersion: 1,
    versions: [{ version: 1, deployedImageName: "redis:7" }],
  },
  {
    appName: "uploader",
    instanceCount: 1,
    containerHttpPort: 8080,
    httpAuth: { user: "admin", password: "HTTPPW_SENTINEL" },
    envVars: [{ key: "UPLOAD_TOKEN", value: "abc" }],
    volumes: [{ containerPath: "/data", hostPath: "/srv/uploads" }],
    customDomain: [],
    deployedVersion: 2,
    versions: [{ version: 2, deployedImageName: "img-captain--uploader:2" }],
  },
  { appName: "draft", instanceCount: 1, envVars: [], volumes: [], customDomain: [], deployedVersion: 0, versions: [] },
  {
    appName: "pg-pool",
    instanceCount: 2,
    notExposeAsWebApp: true,
    envVars: [],
    volumes: [],
    customDomain: [],
    deployedVersion: 1,
    versions: [{ version: 1, deployedImageName: "postgres:15" }],
  },
];

/** The whole answer envelope, as the API returns it. */
export const caproverAppsAnswer = () => ({ appDefinitions: caproverDefinitions(), rootDomain: "captain.example.com", defaultNginxConfig: "server { }" });
