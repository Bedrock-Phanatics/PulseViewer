import type {
  NetworkTransport,
  PulseAsync,
  PulseNetwork,
  PulseNode,
  PulseReport,
  PulseThread,
  ResourceSample,
} from "./model/report.ts";

export function resourceActivity(resources: {
  samples: ResourceSample[];
  samplesDropped?: bigint;
}) {
  let cpuNs = 0n;
  let intervalNs = 0n;
  let cpuPeak: number | null = null;
  let memoryPeak = 0n;
  let rssProcessPeak: bigint | null = null;
  let firstRss: ResourceSample | undefined;
  let lastRss: ResourceSample | undefined;
  let previous: ResourceSample | undefined;
  const samples = resources.samples.map((sample) => {
    const cpu =
      sample.intervalNs >= 1_000_000_000n &&
      sample.cpuUserNs !== null &&
      sample.cpuSystemNs !== null
        ? (Number(sample.cpuUserNs + sample.cpuSystemNs) / Number(sample.intervalNs)) * 100
        : null;
    if (cpu !== null) {
      cpuNs += (sample.cpuUserNs ?? 0n) + (sample.cpuSystemNs ?? 0n);
      intervalNs += sample.intervalNs;
      cpuPeak = Math.max(cpuPeak ?? 0, cpu);
    }
    if (sample.memoryBytes > memoryPeak) memoryPeak = sample.memoryBytes;
    if (sample.rssBytes !== null && sample.rssPeakBytes !== null) {
      if (rssProcessPeak === null || sample.rssPeakBytes > rssProcessPeak)
        rssProcessPeak = sample.rssPeakBytes;
      firstRss ??= sample;
      lastRss = sample;
    }
    // Deltas are against the previous retained sample.
    const memoryDelta = previous ? sample.memoryBytes - previous.memoryBytes : null;
    const rssDelta =
      previous?.rssBytes != null && sample.rssBytes !== null
        ? sample.rssBytes - previous.rssBytes
        : null;
    previous = sample;
    return { ...sample, cpu, memoryDelta, rssDelta };
  });
  const first = samples[0];
  const last = samples.at(-1);
  return {
    samples,
    current: last,
    cpuAverage: intervalNs > 0n ? (Number(cpuNs) / Number(intervalNs)) * 100 : null,
    cpuPeak,
    memoryPeak,
    /** first to last retained sample */
    memoryGrowth: first && last && first !== last ? last.memoryBytes - first.memoryBytes : null,
    /** VmHWM, peak since process launch */
    rssProcessPeak,
    rssCurrent: samples.findLast((sample) => sample.rssBytes !== null)?.rssBytes ?? null,
    rssAvailableSamples: samples.filter((sample) => sample.rssBytes !== null).length,
    rssGrowth:
      firstRss && lastRss && firstRss !== lastRss
        ? (lastRss.rssBytes ?? 0n) - (firstRss.rssBytes ?? 0n)
        : null,
  };
}

export function formatBytes(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const negative = value < 0n;
  const abs = Number(negative ? -value : value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let scaled = abs;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${negative ? "−" : ""}${scaled.toFixed(digits)} ${units[unit]}`;
}

export function signedBytes(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value > 0n ? "+" : ""}${formatBytes(value)}`;
}

export interface PluginZone {
  name: string;
  calls: bigint;
  /** Outermost paths only. */
  totalNs: bigint;
  selfNs: bigint;
}

export interface PluginRow {
  name: string;
  /** Outermost callbacks only. */
  calls: bigint;
  totalNs: bigint;
  selfNs: bigint;
  maxNs: bigint;
  zones: PluginZone[];
}

export type PluginStatus = "legacy" | "no-owners" | "ok";

/** Maps zones to plugins through zone_owners. Total counts outermost callbacks so nesting never double counts, self is additive. */
export function pluginProfile(thread: PulseThread) {
  if (thread.zoneOwners === undefined)
    return {
      status: "legacy" as PluginStatus,
      plugins: [] as PluginRow[],
      selfNs: 0n,
      ownedSelfNs: 0n,
    };
  const owners = new Map(thread.zoneOwners.map((owner) => [owner.zone, owner.plugin]));
  const rows = new Map<string, PluginRow>();
  const zoneRows = new Map<string, Map<number, PluginZone>>();
  let selfNs = 0n;
  let ownedSelfNs = 0n;
  for (const node of thread.nodes) {
    selfNs += node.selfNs;
    const plugin = owners.get(node.zone);
    if (plugin === undefined) continue;
    ownedSelfNs += node.selfNs;
    let row = rows.get(plugin);
    if (!row) {
      row = {
        name: plugin,
        calls: 0n,
        totalNs: 0n,
        selfNs: 0n,
        maxNs: 0n,
        zones: [],
      };
      rows.set(plugin, row);
      zoneRows.set(plugin, new Map());
    }
    let zone = zoneRows.get(plugin)?.get(node.zone);
    if (!zone) {
      zone = {
        name: thread.zones[node.zone] ?? "",
        calls: 0n,
        totalNs: 0n,
        selfNs: 0n,
      };
      zoneRows.get(plugin)?.set(node.zone, zone);
      row.zones.push(zone);
    }
    zone.calls += node.calls;
    zone.selfNs += node.selfNs;
    row.selfNs += node.selfNs;
    let nested = false;
    for (let parent = node.parent; parent > 0; ) {
      const ancestor = thread.nodes[parent - 1];
      if (!ancestor) break;
      if (owners.get(ancestor.zone) === plugin) {
        nested = true;
        break;
      }
      parent = ancestor.parent;
    }
    if (nested) continue;
    row.calls += node.calls;
    row.totalNs += node.totalNs;
    zone.totalNs += node.totalNs;
    if (node.maxNs > row.maxNs) row.maxNs = node.maxNs;
  }
  const plugins = [...rows.values()].sort((a, b) =>
    a.totalNs > b.totalNs ? -1 : a.totalNs < b.totalNs ? 1 : a.name < b.name ? -1 : 1,
  );
  for (const plugin of plugins)
    plugin.zones.sort((a, b) => (a.selfNs > b.selfNs ? -1 : a.selfNs < b.selfNs ? 1 : 0));
  return {
    status: (plugins.length ? "ok" : "no-owners") as PluginStatus,
    plugins,
    selfNs,
    ownedSelfNs,
  };
}

export interface AsyncRow {
  thread: string;
  async: PulseAsync;
  spanNs: bigint;
  /** main stamps submissions, workers measure the tasks they run */
  role: "main" | "worker";
  /** no tasks on the relevant side, distinct from a measured zero */
  hasWork: boolean;
  busyPercent: number | null;
  avgTurnaroundNs: bigint | undefined;
  avgPickupNs: bigint | undefined;
  avgWaitNs: bigint | undefined;
  avgRunNs: bigint | undefined;
  outstanding: bigint;
}

export interface AsyncFinding {
  level: "warn" | "info";
  title: string;
  detail: string;
}

const PICKUP_WARN_NS = 50_000_000n;
const BUSY_WARN_PERCENT = 80;

/** only the main thread gets resource samples */
export function isMainThread(thread: PulseThread): boolean {
  return thread.resources != null || thread.name === "main";
}

export function asyncProfile(report: PulseReport) {
  const rows: AsyncRow[] = [];
  for (const thread of report.threads) {
    const item = thread.async;
    if (!item) continue;
    const spanNs = thread.endedNs - thread.startedNs;
    const role = isMainThread(thread) ? "main" : "worker";
    rows.push({
      thread: thread.name,
      async: item,
      spanNs,
      role,
      hasWork: role === "main" ? item.submitted > 0n : item.ran > 0n,
      busyPercent:
        role === "worker" && item.ran > 0n && spanNs > 0n ? percent(item.runTotalNs, spanNs) : null,
      avgTurnaroundNs: item.completed > 0n ? item.turnaroundTotalNs / item.completed : undefined,
      avgPickupNs: item.completed > 0n ? item.pickupTotalNs / item.completed : undefined,
      avgWaitNs: item.ran > 0n ? item.waitTotalNs / item.ran : undefined,
      avgRunNs: item.ran > 0n ? item.runTotalNs / item.ran : undefined,
      outstanding: item.submitted - item.completed,
    });
  }
  const findings: AsyncFinding[] = [];
  const workers = rows.filter((row) => row.role === "worker" && row.hasWork);
  for (const row of rows.filter((item) => item.role === "main")) {
    if (row.avgPickupNs !== undefined && row.avgPickupNs >= PICKUP_WARN_NS)
      findings.push({
        level: "warn",
        title: `${row.thread}: slow result pickup`,
        detail: `Results waited ${time(row.avgPickupNs)} on average between finishing and being collected, at least one 50 ms tick. The main thread may be falling behind on async results.`,
      });
    if (row.outstanding > 0n)
      findings.push({
        level: "info",
        title: `${row.thread}: ${row.outstanding.toLocaleString()} ${row.outstanding === 1n ? "task" : "tasks"} without a collected result`,
        detail:
          "Submitted tasks that had no collected result when the capture ended. They may have been queued, still running, or finished but uncollected.",
      });
  }
  for (const row of workers) {
    if (row.busyPercent !== null && row.busyPercent >= BUSY_WARN_PERCENT)
      findings.push({
        level: "warn",
        title: `${row.thread}: ${row.busyPercent.toFixed(0)}% busy`,
        detail:
          "This worker spent most of the capture running tasks, so newly queued work likely waited for it. More workers may help if queue waits are also high.",
      });
    if (
      row.avgWaitNs !== undefined &&
      row.avgRunNs !== undefined &&
      row.avgWaitNs >= 5_000_000n &&
      row.avgWaitNs > row.avgRunNs
    )
      findings.push({
        level: "warn",
        title: `${row.thread}: tasks mostly waiting`,
        detail: `Average queue wait ${time(row.avgWaitNs)} exceeds average run time ${time(row.avgRunNs)}. Tasks spent more time queued than executing.`,
      });
  }
  if (workers.length >= 2) {
    const sorted = [...workers].sort((a, b) => (a.async.ran > b.async.ran ? -1 : 1));
    const top = sorted[0];
    const bottom = sorted.at(-1);
    if (top && bottom && top.async.ran >= 10n && top.async.ran >= bottom.async.ran * 3n)
      findings.push({
        level: "info",
        title: "Uneven worker load",
        detail: `${top.thread} ran ${top.async.ran.toLocaleString()} tasks while ${bottom.thread} ran ${bottom.async.ran.toLocaleString()}. Check queue waits before treating this as a problem.`,
      });
  }
  const mains = rows.filter((row) => row.role === "main");
  const sum = (items: AsyncRow[], pick: (async: PulseAsync) => bigint) =>
    items.reduce((total, row) => total + pick(row.async), 0n);
  const completed = sum(mains, (a) => a.completed);
  const ran = sum(workers, (a) => a.ran);
  return {
    rows,
    findings,
    totals: {
      submitted: sum(mains, (a) => a.submitted),
      completed,
      ran,
      queuePeak: mains.reduce(
        (max, row) => (row.async.queuePeak > max ? row.async.queuePeak : max),
        0n,
      ),
      workers: rows.filter((row) => row.role === "worker").length,
      idleWorkers: rows.filter((row) => row.role === "worker" && !row.hasWork).length,
      avgTurnaroundNs:
        completed > 0n ? sum(mains, (a) => a.turnaroundTotalNs) / completed : undefined,
      avgPickupNs: completed > 0n ? sum(mains, (a) => a.pickupTotalNs) / completed : undefined,
      avgWaitNs: ran > 0n ? sum(workers, (a) => a.waitTotalNs) / ran : undefined,
      avgRunNs: ran > 0n ? sum(workers, (a) => a.runTotalNs) / ran : undefined,
      busiest: workers.reduce<AsyncRow | undefined>(
        (best, row) => ((row.busyPercent ?? 0) > (best?.busyPercent ?? -1) ? row : best),
        undefined,
      ),
    },
  };
}

export interface TransportInfo {
  label: string;
  group: "traffic" | "pressure" | "peak";
  kind: "bytes" | "count";
  detail: string;
}

/** documented counters, anything else renders generically */
export const KNOWN_COUNTERS: Record<string, TransportInfo> = {
  bytes_sent: {
    label: "Bytes sent",
    group: "traffic",
    kind: "bytes",
    detail: "Bytes the transport wrote to the network during the capture.",
  },
  bytes_received: {
    label: "Bytes received",
    group: "traffic",
    kind: "bytes",
    detail: "Bytes the transport read from the network during the capture.",
  },
  batches_sent: {
    label: "Batches sent",
    group: "traffic",
    kind: "count",
    detail: "Packet batches the transport sent during the capture.",
  },
  packets_received: {
    label: "Packets received",
    group: "traffic",
    kind: "count",
    detail: "Packets the transport received during the capture.",
  },
  packets_rejected: {
    label: "Packets rejected",
    group: "pressure",
    kind: "count",
    detail:
      "Packets the transport rejected. The counter records no reason, and a rejection does not imply malicious intent.",
  },
  unreliable_dropped: {
    label: "Unreliable packets dropped",
    group: "pressure",
    kind: "count",
    detail:
      "Unreliable packets the transport dropped. Unreliable traffic tolerates loss by design.",
  },
  receive_pauses: {
    label: "Receive pauses",
    group: "pressure",
    kind: "count",
    detail: "Times the transport paused receiving to apply backpressure.",
  },
  event_stalls: {
    label: "Event stalls",
    group: "pressure",
    kind: "count",
    detail: "Event stalls counted by the native transport, a sign of queue pressure.",
  },
  overload_disconnects: {
    label: "Overload disconnects",
    group: "pressure",
    kind: "count",
    detail: "Sessions the transport disconnected because of overload.",
  },
  sessions_peak: {
    label: "Peak active sessions",
    group: "peak",
    kind: "count",
    detail: "Highest number of simultaneous transport sessions observed. A peak, not a delta.",
  },
  command_queue_peak_bytes: {
    label: "Peak send-queue size",
    group: "peak",
    kind: "bytes",
    detail: "Largest backlog of outgoing commands, in bytes. A peak, not a delta.",
  },
  event_queue_peak_bytes: {
    label: "Peak event-queue size",
    group: "peak",
    kind: "bytes",
    detail: "Largest backlog of incoming events, in bytes. A peak, not a delta.",
  },
};

export const TRANSPORT_LABELS = {
  bedwire: "Bedwire (NetherNet)",
  raklib: "RakLib",
} as const;

function describeCounter(name: string): TransportInfo & { known: boolean } {
  const known = KNOWN_COUNTERS[name];
  if (known) return { ...known, known: true };
  const words = name.split("_");
  const label = `${words[0]?.charAt(0).toUpperCase() ?? ""}${words[0]?.slice(1) ?? ""}${words.length > 1 ? ` ${words.slice(1).join(" ")}` : ""}`;
  return {
    label,
    group: name.includes("peak") ? "peak" : "pressure",
    kind: name.includes("bytes") ? "bytes" : "count",
    detail: `Reported by this Quark version as “${name}”. This viewer has no description for it; the value is shown as recorded.`,
    known: false,
  };
}

/** known counters in documented order, then unknown ones alphabetically */
export function orderedCounters(transport: NetworkTransport) {
  const order = Object.keys(KNOWN_COUNTERS);
  return transport.counters
    .map((counter) => ({ ...counter, info: describeCounter(counter.name) }))
    .sort((a, b) => {
      const left = order.indexOf(a.name);
      const right = order.indexOf(b.name);
      if (left >= 0 || right >= 0) return (left < 0 ? 1e9 : left) - (right < 0 ? 1e9 : right);
      return a.name < b.name ? -1 : 1;
    });
}

export function networkActivity(network: PulseNetwork, session: number | null | "all" = "all") {
  const buckets = new Map<
    bigint,
    {
      offsetNs: bigint;
      packets: bigint;
      receivedBytes: bigint;
      decodeFailed: bigint;
    }
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
      bucket = {
        offsetNs: window.offsetNs,
        packets: 0n,
        receivedBytes: 0n,
        decodeFailed: 0n,
      };
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
