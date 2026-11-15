/**
 * App move (relocate an app to another server) — the stable machine codes the hub emits and the web UI translates.
 * Single source of truth: the hub imports these lists to type what it returns, and a web test asserts every code
 * has an i18n key (`moveBlocker_<code>`, `moveWarn_<code>`, `moveErr_<code>`), so neither side can drift.
 */

export const APP_MOVE_PHASES = [
  "QUEUED",
  "PRECHECK",
  "STOPPING_SOURCE",
  "TRANSFERRING",
  "DEPLOYING",
  "FINALIZING",
  "COMPLETED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "FAILED",
] as const;
export type AppMovePhaseName = (typeof APP_MOVE_PHASES)[number];

/** Phases in which a move is still live (the one-active-move-per-app partial index excludes the rest). */
export const APP_MOVE_ACTIVE_PHASES = ["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING", "DEPLOYING", "FINALIZING", "ROLLING_BACK"] as const;
export const APP_MOVE_TERMINAL_PHASES = ["COMPLETED", "ROLLED_BACK", "FAILED"] as const;

/** Acknowledgements a move can require (each is one risk the operator accepts explicitly). */
export const APP_MOVE_ACKS = [
  "hostMounts",
  "externalVolumes",
  "dropPrivilegedOptions",
  "dropGpus",
  "resetCpuset",
  "hostPortChanged",
  "domainChanges",
] as const;
export type AppMoveAck = (typeof APP_MOVE_ACKS)[number];

/** Blockers that disappear once the matching acknowledgement is ticked (blocker code → ack key). */
export const APP_MOVE_ACK_BLOCKERS = {
  external_volume: "externalVolumes",
  host_mounts: "hostMounts",
  privileged_options: "dropPrivilegedOptions",
  gpus_unavailable: "dropGpus",
  cpuset_exceeds: "resetCpuset",
  host_port_changed: "hostPortChanged",
  domain_changes: "domainChanges",
} as const satisfies Record<string, AppMoveAck>;

export const APP_MOVE_BLOCKER_CODES = [
  "same_server",
  "cross_team",
  "app_is_preview",
  "agent_offline_source",
  "agent_offline_target",
  "probe_failed",
  "agent_too_old",
  "capability_missing",
  "no_curl",
  "no_tool",
  "cluster_app",
  "target_in_cluster",
  "previews_exist",
  "db_links_exist",
  "db_network",
  "rollout_active",
  "deploy_active",
  "move_active",
  "move_active_on_server",
  "move_needs_attention",
  "alias_conflict",
  "network_alias_conflict",
  "ports_conflict",
  "target_volume_exists",
  "bad_volume_name",
  "disk_insufficient",
  "build_server_offline",
  "link_probe_failed",
  "privileged_not_owner",
  ...(Object.keys(APP_MOVE_ACK_BLOCKERS) as (keyof typeof APP_MOVE_ACK_BLOCKERS)[]),
] as const;
export type AppMoveBlockerCode = (typeof APP_MOVE_BLOCKER_CODES)[number];

export const APP_MOVE_WARNING_CODES = [
  "dns_manual_repoint",
  "magic_domain_changes",
  "self_urls_rewritten",
  "env_may_reference_old_host",
  "local_backups_stranded",
  "history_splits",
  "image_may_differ",
  "git_rebuild",
  "downtime_estimate",
  "tunnel_resync",
  "xattrs_acl_not_preserved",
  "custom_cert_redelivered",
  "archive_overwritten",
  "source_volume_absent",
  "stopped_app_started_briefly",
  "tls_http01_gap",
  "proxy_will_be_installed",
  // Recorded by the runner while it executes (never by preflight):
  "deploy_failed_after_move",
  "dns_repoint_failed",
  "source_cleanup_failed",
  "staging_cleanup_failed",
  "post_cutover_sync_failed",
] as const;
export type AppMoveWarningCode = (typeof APP_MOVE_WARNING_CODES)[number];

/** Why a move rolled back / failed (AppMove.failureReason). */
export const APP_MOVE_FAILURE_REASONS = [
  "preflight_changed",
  "cancelled",
  "agent_offline",
  "stop_failed",
  "stop_unverified",
  "prepare_failed",
  "pack_failed",
  "part_stat_failed",
  "transfer_failed",
  "size_mismatch",
  "sha_mismatch",
  "apply_aborted",
  "apply_rolled_back",
  "apply_rollback_failed",
  "apply_failed",
  "entry_count_mismatch",
  "changed_under_us",
  "cutover_failed",
  "deploy_failed",
  "deploy_timeout",
  "hub_restarted",
  "deadline_exceeded",
  "source_restart_failed",
  "internal_error",
] as const;
export type AppMoveFailureReason = (typeof APP_MOVE_FAILURE_REASONS)[number];

/** Per-volume state inside AppMove.volumes. */
export const APP_MOVE_VOLUME_STATES = ["PENDING", "PACKED", "TRANSFERRED", "APPLIED", "SKIPPED"] as const;
