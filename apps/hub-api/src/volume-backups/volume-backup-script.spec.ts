import {
  buildVolumeBackupScript,
  buildVolumeRestoreScript,
  buildVolumeDeleteScript,
  volumeBackupFilename,
} from "./volume-backup-script";
import type { DestinationSpec } from "../backups/destination";

const LOCAL: DestinationSpec = { type: "LOCAL", encryption: { enabled: false, key: "" } };
const S3: DestinationSpec = {
  type: "S3",
  s3: { bucket: "b", region: "r", endpoint: "s3.example.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" },
  encryption: { enabled: false, key: "" },
};
const ENC: DestinationSpec = { type: "LOCAL", encryption: { enabled: true, key: "pass" } };

describe("volume-backup-script", () => {
  it("LOCAL: tars the docker volume → gzip → file, prints size", () => {
    const s = buildVolumeBackupScript("a1", "data", "tugra_appv_a1_data", "20260101.tar.gz", LOCAL);
    expect(s).toContain("docker run --rm -v 'tugra_appv_a1_data':/data:ro alpine tar -C /data -cf - .");
    expect(s).toContain("| gzip");
    expect(s).toContain("> /etc/tugra/volume-backups/a1/data/20260101.tar.gz");
    expect(s).toContain("stat -c %s /etc/tugra/volume-backups/a1/data/20260101.tar.gz");
    expect(s).not.toContain("gpg");
  });

  it("S3: pipes to mc under <prefix>/<appId>/<vol>/<file> and reports size", () => {
    const fn = volumeBackupFilename("20260101", S3);
    const s = buildVolumeBackupScript("a1", "data", "tugra_appv_a1_data", fn, S3);
    expect(s).toContain("MC_HOST_tdest=");
    expect(s).toContain("mc pipe tdest/b/tugra/a1/data/20260101.tar.gz");
    expect(s).toContain("mc stat --json tdest/b/tugra/a1/data/20260101.tar.gz");
  });

  it("encryption adds a gpg stage and a .gpg suffix", () => {
    const fn = volumeBackupFilename("20260101", ENC);
    expect(fn).toBe("20260101.tar.gz.gpg");
    const s = buildVolumeBackupScript("a1", "data", "v", fn, ENC);
    expect(s).toContain("gpg --batch --yes --passphrase 'pass' --symmetric --cipher-algo AES256");
  });

  it("restore clears the volume then extracts the tar", () => {
    const s = buildVolumeRestoreScript("a1", "data", "tugra_appv_a1_data", "20260101.tar.gz", LOCAL);
    expect(s).toContain("gunzip");
    expect(s).toContain("docker run --rm -i -v 'tugra_appv_a1_data':/data alpine sh -c");
    expect(s).toContain("find . -mindepth 1 -delete");
    expect(s).toContain("tar -xf -");
  });

  it("delete removes the local file or the S3 object", () => {
    expect(buildVolumeDeleteScript("a1", "data", "x.tar.gz", LOCAL)).toContain("rm -f /etc/tugra/volume-backups/a1/data/x.tar.gz");
    expect(buildVolumeDeleteScript("a1", "data", "x.tar.gz", S3)).toContain("mc rm tdest/b/tugra/a1/data/x.tar.gz");
  });
});
