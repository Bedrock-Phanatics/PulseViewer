export interface PulseNode {
  id: number;
  zone: number;
  parent: number;
  calls: bigint;
  totalNs: bigint;
  selfNs: bigint;
  maxNs: bigint;
  activeTicks: bigint;
}

export interface PulseTick {
  id: bigint;
  offsetNs: bigint;
  durationNs: bigint;
}

export interface SpikeNode {
  id: number;
  calls: bigint;
  totalNs: bigint;
  selfNs: bigint;
}

export interface PulseSpike {
  tick: PulseTick;
  nodes: SpikeNode[];
}

export interface ResourceSample {
  offsetNs: bigint;
  intervalNs: bigint;
  cpuUserNs: bigint | null;
  cpuSystemNs: bigint | null;
  memoryBytes: bigint;
  memoryAllocatedBytes: bigint;
  /** Null when unavailable or before v4 */
  rssBytes: bigint | null;
  /** Null together with rssBytes */
  rssPeakBytes: bigint | null;
}

export interface PulseResources {
  samples: ResourceSample[];
  samplesDropped: bigint;
  /** v4 and newer */
  hasRss: boolean;
}

/** Main fills the submit side, workers the run side */
export interface PulseAsync {
  submitted: bigint;
  completed: bigint;
  queuePeak: bigint;
  turnaroundTotalNs: bigint;
  turnaroundMaxNs: bigint;
  pickupTotalNs: bigint;
  pickupMaxNs: bigint;
  ran: bigint;
  waitTotalNs: bigint;
  waitMaxNs: bigint;
  runTotalNs: bigint;
  runMaxNs: bigint;
  heapBytes: bigint;
  heapPeakBytes: bigint;
}

export interface ZoneOwner {
  zone: number;
  plugin: string;
}

export const NETWORK_TRANSPORTS = ["raklib", "bedwire"] as const;

export interface TransportCounter {
  name: string;
  value: bigint;
}

export interface NetworkTransport {
  name: (typeof NETWORK_TRANSPORTS)[number];
  counters: TransportCounter[];
}

export const NETWORK_PHASES = [
  "session_start",
  "login",
  "awaiting_async",
  "handshake",
  "resource_packs",
  "pre_spawn",
  "spawn_response",
  "in_game",
  "death",
  "closed",
  "unknown",
] as const;
export const NETWORK_REASONS = [
  "rate.batch",
  "rate.packet",
  "batch.packet_limit",
  "batch.empty",
  "batch.malformed",
  "packet.unknown",
  "packet.direction",
  "packet.state",
  "packet.malformed",
  "packet.handler_validation",
  "compression.algorithm",
  "decompression.malformed",
  "decompression.limit",
  "encryption.invalid",
  "packet.bad_packet_disconnect",
  "transport.header",
  "packet.size",
] as const;
export const NETWORK_ACTIONS = ["drop_packet", "drop_batch", "reject_batch", "disconnect"] as const;

export interface NetworkSession {
  id: number;
  firstNs: bigint;
  protocol: number | null;
  initialPhase: (typeof NETWORK_PHASES)[number];
  phase: (typeof NETWORK_PHASES)[number];
  closedNs: bigint | null;
}

export interface NetworkEvent {
  offsetNs: bigint;
  tickId: bigint | null;
  sessionId: number | null;
  packetId: number | null;
  reason: (typeof NETWORK_REASONS)[number];
  observed: bigint | null;
  limit: bigint | null;
  action: (typeof NETWORK_ACTIONS)[number];
  phase: (typeof NETWORK_PHASES)[number];
}

export interface NetworkWindow {
  offsetNs: bigint;
  sessionId: number | null;
  batches: bigint;
  packets: bigint;
  receivedBytes: bigint;
  decompressedBytes: bigint;
  decoded: bigint;
  decodeFailed: bigint;
  pluginCancelled: bigint;
  stateDropped: bigint;
  repeatedDropped: bigint;
}

export interface PulseNetwork {
  fromNs: bigint;
  toNs: bigint;
  windowNs: bigint;
  sessions: NetworkSession[];
  events: NetworkEvent[];
  windows: NetworkWindow[];
  sessionsDropped: bigint;
  eventsDropped: bigint;
  windowsDropped: bigint;
  counterOverflows: bigint;
  /** v4+ */
  transports?: NetworkTransport[];
}

export interface PulseThread {
  network?: PulseNetwork;
  resources?: PulseResources | null;
  slowTickCount?: bigint;
  /** Zone index to plugin full name, ascending (v4+) */
  zoneOwners?: ZoneOwner[];
  /** v4+, null if the thread never recorded. */
  async?: PulseAsync | null;
  name: string;
  startedNs: bigint;
  endedNs: bigint;
  recording: boolean;
  zones: string[];
  nodes: PulseNode[];
  ticks: PulseTick[];
  tickCount: bigint;
  tickTotalNs: bigint;
  tickMaxNs: bigint;
  tickCapacity: number;
  spikes: PulseSpike[];
  spikesDropped: bigint;
  spikeThresholdNs: bigint;
  maxSpikes: number;
  durationNs: bigint;
  unbalancedScopes: bigint;
  droppedScopes: bigint;
  unbalancedTicks: bigint;
}

export interface PulseReport {
  version: 1 | 2 | 3 | 4;
  metadata: {
    quarkVersion: string;
    phpVersion: string;
    platform: string;
    cpuThreads: number;
    createdUnixMs: bigint;
    plugins: { name: string; version: string }[];
    worlds: string[];
  };
  threads: PulseThread[];
}
