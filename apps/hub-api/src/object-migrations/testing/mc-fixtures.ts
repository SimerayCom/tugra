/**
 * REAL `mc` output captured from the pinned release (RELEASE.2025-08-13T08-35-41Z, darwin-arm64) against local
 * filesystem aliases with the same JSON writers the S3 code path uses (paths replaced by `<P>`). Field names, number
 * types and the numeric `diff` enum are exactly what mc printed; S3 additionally fills etag/storageClass/versionId.
 * Lab item L1 still has to re-capture these against a throwaway MinIO for the S3-only commands (anonymous / ilm / tag /
 * version info), which a filesystem alias cannot exercise.
 */
export const MC_LS_JSON = [
  '{"status":"success","type":"folder","lastModified":"2026-11-15T12:59:16.737358065+03:00","size":128,"key":"bk1/","etag":"","url":"<P>/a/","versionOrdinal":1}',
  '{"status":"success","type":"folder","lastModified":"2026-11-15T12:59:16.73896654+03:00","size":96,"key":"bk2/","etag":"","url":"<P>/a/","versionOrdinal":1}',
].join("\n");

export const MC_DU_JSON = '{"prefix":"a/bk1","size":12,"objects":2,"status":"success","isVersions":false}';

export const MC_MIRROR_JSON = [
  '{"status":"success","source":"<P>/a/bk1/one.txt","target":"b/bk1/one.txt","size":6,"totalCount":1,"totalSize":6,"eventTime":"","eventType":""}',
  '{"status":"success","source":"<P>/a/bk1/sub/two.txt","target":"b/bk1/sub/two.txt","size":6,"totalCount":2,"totalSize":12,"eventTime":"","eventType":""}',
  '{"status":"success","source":"<P>/a/bk2/blob.bin","target":"b/bk2/blob.bin","size":5000,"totalCount":3,"totalSize":5012,"eventTime":"","eventType":""}',
  '{"status":"success","total":5012,"transferred":5012,"duration":3574250,"speed":1402252.220745611}',
].join("\n");

/** mc prints these out of order across workers (totalCount 3,2,1): progress must use the MAX, never the last line. */
export const MC_MIRROR_OUT_OF_ORDER_JSON = [
  '{"status":"success","source":"<P>/a/bk2/blob.bin","target":"b/bk2/blob.bin","size":5000,"totalCount":3,"totalSize":5014,"eventTime":"","eventType":""}',
  '{"status":"success","source":"<P>/a/bk1/one.txt","target":"b/bk1/one.txt","size":8,"totalCount":2,"totalSize":14,"eventTime":"","eventType":""}',
  '{"status":"success","source":"<P>/a/bk1/new.txt","target":"b/bk1/new.txt","size":6,"totalCount":1,"totalSize":6,"eventTime":"","eventType":""}',
  '{"status":"success","total":5014,"transferred":5014,"duration":1948250,"speed":2573591.684845374}',
].join("\n");

export const MC_MIRROR_ERROR_JSON =
  '{"status":"error","error":{"message":"Unable to stat source `nosuch`.","cause":{"message":"Requested path `<P>/nosuch` not found","error":{"Path":"<P>/nosuch"}},"type":"fatal"}}';

/** `diff` is the NUMERIC enum: 5 = only in first (missing on target), 6 = only in second (extra), 2 = size differs. */
export const MC_DIFF_JSON = [
  '{"status":"success","first":"","second":"<P>/b/bk1/extra.txt","diff":6}',
  '{"status":"success","first":"<P>/a/bk1/new.txt","second":"","diff":5}',
  '{"status":"success","first":"<P>/a/bk1/one.txt","second":"<P>/b/bk1/one.txt","diff":2}',
  '{"status":"success","first":"<P>/a/bk2/blob.bin","second":"","diff":5}',
].join("\n");

/** Exported policy / lifecycle / tags (S3-side commands: shapes per the mc docs, re-capture under lab L1). */
export const MC_POLICY_JSON = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::bk1/*"]}]}';
export const MC_EMPTY_POLICY_JSON = '{"Version":"2012-10-17","Statement":[]}';
export const MC_ILM_JSON = '{"Rules":[{"ID":"expire-tmp","Status":"Enabled","Filter":{"Prefix":"tmp/"},"Expiration":{"Days":7}}]}';
export const MC_TAGS_JSON = '{"status":"success","url":"dst/bk1","tagset":{"env":"prod","team":"web"}}';
export const MC_VERSION_INFO_ENABLED = '{"status":"success","url":"src/bk1","versioning":{"status":"Enabled"}}';

export const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
