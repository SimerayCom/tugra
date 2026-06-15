/**
 * @tugra/shared — types shared between the hub and the agent.
 * The agent (Go) mirrors these shapes; keep them in sync.
 */

export const PROTOCOL_VERSION = 1;

export type ServerStatus = "PENDING" | "ONLINE" | "OFFLINE";

/** A point-in-time snapshot the agent streams to the hub. */
export interface MetricsSample {
  ts: number; // unix ms
  cpu: number; // 0..100
  memUsed: number; // bytes
  memTotal: number; // bytes
  diskUsed: number; // bytes
  diskTotal: number; // bytes
  netRx: number; // bytes/s
  netTx: number; // bytes/s
}

/** Agent -> Hub: first message after the socket opens. */
export interface EnrollMsg {
  type: "enroll";
  protocol: number;
  token: string;
  agentVersion: string;
  hostname: string;
}

/** Agent -> Hub: periodic metrics. */
export interface MetricsMsg {
  type: "metrics";
  sample: MetricsSample;
}

/** Agent -> Hub: liveness ping. */
export interface HeartbeatMsg {
  type: "heartbeat";
  ts: number;
}

/** Hub -> Agent: enrollment result + the server's signed identity ("seal"). */
export interface EnrolledMsg {
  type: "enrolled";
  serverId: string;
  seal: string; // the server's unique signed identity ("Sunucu Tuğrası")
}

export type AgentMessage = EnrollMsg | MetricsMsg | HeartbeatMsg;
export type HubMessage = EnrolledMsg;
