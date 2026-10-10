import type { PulseNetwork, PulseNode, PulseThread } from "./model/report.ts";

export function networkActivity(network: PulseNetwork, session: number | null | "all" = "all") {
  const buckets = new Map<
    bigint,
    { offsetNs: bigint; packets: bigint; receivedBytes: bigint; decodeFailed: bigint }
  >();
  const totals = {
    batches: 0n,
    packets: 0n,
    receivedBytes: 0n,
    decompressedBytes: 0n,
    decoded: 0n,
    decodeFailed: 0n,
    pluginCancelled: 0n,
    stateDropped: 0n,
    repeatedDropped: 0n,
  };
  for (const window of network.windows) {
    if (session !== "all" && window.sessionId !== session) continue;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += window[key];
    let bucket = buckets.get(window.offsetNs);
    if (!bucket) {
      bucket = { offsetNs: window.offsetNs, packets: 0n, receivedBytes: 0n, decodeFailed: 0n };
      buckets.set(window.offsetNs, bucket);
    }
    bucket.packets += window.packets;
    bucket.receivedBytes += window.receivedBytes;
    bucket.decodeFailed += window.decodeFailed;
  }
  return {
    totals,
    buckets: [...buckets.values()],
    events: network.events.filter((event) => session === "all" || event.sessionId === session),
  };
}

export interface Hotspot {
  name: string;
  calls: bigint;
  totalNs: bigint;
  selfNs: bigint;
  maxNs: bigint;
}

export type SortKey = "totalNs" | "selfNs" | "calls" | "maxNs" | "average";
const milliseconds = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

export function compare(a: Hotspot | PulseNode, b: Hotspot | PulseNode, key: SortKey): number {
  if (key === "average") {
    const left = a.totalNs * (b.calls || 1n);
    const right = b.totalNs * (a.calls || 1n);
    return left > right ? -1 : left < right ? 1 : 0;
  }
  return a[key] > b[key] ? -1 : a[key] < b[key] ? 1 : 0;
}

export function analyze(thread: PulseThread) {
  const children: PulseNode[][] = Array.from({ length: thread.nodes.length + 1 }, () => []);
  const zones = new Map<string, Hotspot>();
  let selfNs = 0n;
  let rootNs = 0n;
  for (const node of thread.nodes) {
    children[node.parent]?.push(node);
    const name = thread.zones[node.zone] ?? "";
    let zone = zones.get(name);
    if (!zone) {
      zone = { name, calls: 0n, totalNs: 0n, selfNs: 0n, maxNs: 0n };
      zones.set(name, zone);
    }
    zone.calls += node.calls;
    zone.totalNs += node.totalNs;
    zone.selfNs += node.selfNs;
    if (node.maxNs > zone.maxNs) zone.maxNs = node.maxNs;
    selfNs += node.selfNs;
    if (node.parent === 0) rootNs += node.totalNs;
  }
  const durations = thread.ticks
    .map((tick) => tick.durationNs)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const percentile = (fraction: number) => durations[Math.ceil(durations.length * fraction) - 1];
  const hotspots = [...zones.values()].sort((a, b) => compare(a, b, "selfNs"));
  const spikes = new Map(thread.spikes.map((spike) => [spike.tick.id, spike]));
  return {
    children,
    hotspots,
    selfNs,
    rootNs,
    p95: percentile(0.95),
    p99: percentile(0.99),
    spikes,
  };
}

export type Analysis = ReturnType<typeof analyze>;

export function treeRows(
  thread: PulseThread,
  analysis: Analysis,
  collapsed: Set<number>,
  key: SortKey,
  query: string,
  direction = 1,
): { node: PulseNode; depth: number }[] {
  const visible = new Uint8Array(thread.nodes.length + 1);
  if (query) {
    for (let i = thread.nodes.length - 1; i >= 0; i--) {
      const node = thread.nodes[i];
      if (!node) continue;
      if ((thread.zones[node.zone] ?? "").toLowerCase().includes(query)) visible[node.id] = 1;
      if (visible[node.id]) visible[node.parent] = 1;
    }
  }
  const result: { node: PulseNode; depth: number }[] = [];
  const stack: { node: PulseNode; depth: number }[] = [];
  const push = (parent: number, depth: number) => {
    const siblings = (analysis.children[parent] ?? []).filter((node) => !query || visible[node.id]);
    siblings.sort((a, b) => compare(a, b, key) * direction);
    for (let i = siblings.length - 1; i >= 0; i--) {
      const node = siblings[i];
      if (node) stack.push({ node, depth });
    }
  };
  push(0, 0);
  while (stack.length) {
    const row = stack.pop();
    if (!row) break;
    result.push(row);
    if (query || !collapsed.has(row.node.id)) push(row.node.id, row.depth + 1);
  }
  return result;
}

export function percent(value: bigint, total: bigint): number {
  return total > 0n ? Number((value * 10_000n) / total) / 100 : 0;
}

export function time(value: bigint | undefined): string {
  if (value === undefined) return "—";
  if (value === 0n) return "0 ms";
  if (value < 1_000n) return `${value} ns`;
  if (value < 1_000_000n) return `${(Number(value) / 1_000).toFixed(2)} µs`;
  return `${milliseconds.format(Number(value) / 1_000_000)} ms`;
}

export function elapsed(thread: PulseThread): string {
  const seconds = Number(thread.endedNs - thread.startedNs) / 1e9;
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
    : `${seconds.toFixed(2)} s`;
}
