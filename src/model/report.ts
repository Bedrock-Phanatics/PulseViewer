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

export interface PulseThread {
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
  version: 1;
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
