import {
  buildDatabaseRunScript,
  buildDbRemoveScript,
  connectionInfo,
  credentialEnv,
  engineCommand,
  enginePort,
  resolveImage,
  type DbCredentials,
  type DbEngine,
  type DbSpec,
} from "./database-script";

const creds: DbCredentials = { username: "tugra", password: "p@ss", database: "appdb" };

function spec(engine: DbEngine, over: Partial<DbSpec> = {}): DbSpec {
  return {
    id: "db1",
    engine,
    image: resolveImage(engine),
    port: enginePort(engine),
    hostPort: null,
    credentials: creds,
    ...over,
  };
}

describe("database-script", () => {
  describe("resolveImage / enginePort", () => {
    it("resolves default images and ports per engine", () => {
      expect(resolveImage("POSTGRES")).toBe("postgres:16");
      expect(resolveImage("MYSQL")).toBe("mysql:8");
      expect(resolveImage("REDIS")).toBe("redis:7-alpine");
      expect(resolveImage("MONGO")).toBe("mongo:7");
      expect(resolveImage("POSTGRES", "15")).toBe("postgres:15");
      expect(enginePort("POSTGRES")).toBe(5432);
      expect(enginePort("REDIS")).toBe(6379);
    });
  });

  describe("credentialEnv", () => {
    it("maps credentials to each engine's bootstrap env", () => {
      expect(credentialEnv("POSTGRES", creds)).toMatchObject({ POSTGRES_PASSWORD: "p@ss", POSTGRES_DB: "appdb" });
      expect(credentialEnv("MYSQL", creds)).toMatchObject({ MYSQL_ROOT_PASSWORD: "p@ss", MYSQL_USER: "tugra" });
      expect(credentialEnv("MONGO", creds)).toMatchObject({ MONGO_INITDB_ROOT_PASSWORD: "p@ss" });
      expect(credentialEnv("REDIS", creds)).toEqual({});
    });
  });

  describe("engineCommand", () => {
    it("passes the password to redis via --requirepass; empty for others", () => {
      expect(engineCommand("REDIS", creds)).toContain("--requirepass");
      expect(engineCommand("POSTGRES", creds)).toBe("");
    });
  });

  describe("buildDatabaseRunScript", () => {
    it("joins tugra-net, mounts a named volume, no traefik/domain", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES"));
      expect(s).toContain("docker network create tugra-net");
      expect(s).toContain("--network tugra-net");
      expect(s).toContain("-v tugra_dbv_db1:/var/lib/postgresql/data");
      expect(s).toContain("--name tugra_db_db1");
      expect(s).toContain("-e 'POSTGRES_PASSWORD=p@ss'");
      expect(s).not.toContain("traefik");
      expect(s).not.toContain("certresolver");
    });

    it("adds a host port mapping only when requested", () => {
      expect(buildDatabaseRunScript(spec("POSTGRES"))).not.toContain("-p ");
      expect(buildDatabaseRunScript(spec("POSTGRES", { hostPort: 5455 }))).toContain("-p 5455:5432");
    });

    it("appends the redis requirepass command after the image", () => {
      const s = buildDatabaseRunScript(spec("REDIS"));
      expect(s).toContain("redis:7-alpine");
      expect(s).toContain("redis-server --requirepass");
    });
  });

  describe("buildDbRemoveScript", () => {
    it("removes the container and its volume (data dropped)", () => {
      const s = buildDbRemoveScript({ id: "db1" });
      expect(s).toContain("docker rm -f tugra_db_db1");
      expect(s).toContain("docker volume rm tugra_dbv_db1");
    });
  });

  describe("connectionInfo", () => {
    it("builds an engine-specific URI with the container name as host", () => {
      expect(connectionInfo(spec("POSTGRES")).uri).toBe("postgresql://tugra:p@ss@tugra_db_db1:5432/appdb");
      expect(connectionInfo(spec("MYSQL")).uri).toBe("mysql://tugra:p@ss@tugra_db_db1:3306/appdb");
      expect(connectionInfo(spec("REDIS")).uri).toBe("redis://:p@ss@tugra_db_db1:6379");
      expect(connectionInfo(spec("MONGO")).uri).toBe("mongodb://tugra:p@ss@tugra_db_db1:27017");
      expect(connectionInfo(spec("POSTGRES")).internalHost).toBe("tugra_db_db1");
    });
  });
});
