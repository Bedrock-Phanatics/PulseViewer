import type { PulseNode, PulseReport, PulseThread, PulseTick } from "../model/report.ts";

export const MAX_BYTES = 8_388_608;
const MAX_INT = 9_223_372_036_854_775_807n;
const encoder = new TextEncoder();

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

function requireValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ReportError(message);
}

function object(value: unknown, keys: number): Record<string, unknown> {
  requireValid(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Invalid report object.",
  );
  requireValid(Object.keys(value).length === keys, "Unexpected or missing report fields.");
  return value as Record<string, unknown>;
}

function list(value: unknown, max: number): unknown[] {
  requireValid(Array.isArray(value) && value.length <= max, "Invalid or oversized report list.");
  return value;
}

function integer(value: unknown, min = 0n, max = MAX_INT): bigint {
  requireValid(
    typeof value === "bigint" && value >= min && value <= max,
    "Invalid report integer.",
  );
  return value;
}

function tuple(value: unknown, size: number): bigint[] {
  const row = list(value, size);
  requireValid(row.length === size, "Invalid report row length.");
  return row.map((item) => integer(item));
}

function checkJsonBudget(json: string): void {
  let quoted = false;
  let depth = 0;
  let containers = 0;
  let values = 0;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "[" || char === "{") {
      requireValid(++depth < 16, "Report JSON is nested too deeply.");
      requireValid(++containers <= 300_000, "Report exceeds the container limit.");
    } else if (char === "]" || char === "}") {
      depth--;
    } else if (char === ",") {
      requireValid(++values <= 1_500_000, "Report exceeds the value limit.");
    }
  }
}

async function decompress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let compressedOffset = 0;
  // Small input chunks bound native inflater output before the size check.
  const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (compressedOffset === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(compressedOffset + 1024, bytes.length);
      controller.enqueue(bytes.subarray(compressedOffset, end));
      compressedOffset = end;
    },
  })
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      requireValid(size <= MAX_BYTES, "Decompressed report exceeds the 8 MiB limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ReportError) throw error;
    throw new ReportError("Corrupt, truncated, or unsupported gzip report.");
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function parseReport(input: ArrayBuffer): Promise<PulseReport> {
  requireValid(input.byteLength <= MAX_BYTES, "Report exceeds the 8 MiB limit.");
  let bytes = new Uint8Array(input);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await decompress(bytes);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ReportError("Report contains invalid UTF-8.");
  }
  checkJsonBudget(json);
  let data: unknown;
  try {
    data = JSON.parse(json, (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      requireValid(
        typeof context?.source === "string",
        "This browser cannot read 64-bit Pulse values. Update your browser and try again.",
      );
      requireValid(/^-?\d{1,19}$/.test(context.source), "Report numbers must be 64-bit integers.");
      return integer(BigInt(context.source));
    });
  } catch (error) {
    if (error instanceof ReportError) throw error;
    throw new ReportError("Invalid or truncated report JSON.");
  }
  return normalize(data);
}

function normalize(data: unknown): PulseReport {
  const report = object(data, 5);
  requireValid(
    report.format === "quark.pulse" && report.version === 1n && report.time_unit === "ns",
    "Unsupported Pulse format or version. Expected quark.pulse v1 in nanoseconds.",
  );
  let textBudget = MAX_BYTES / 2;
  let rowBudget = 131_072;
  function text(value: unknown, max: number): string {
    requireValid(
      typeof value === "string" && value.length > 0 && value.length <= max,
      "Invalid report text.",
    );
    requireValid(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
      "Report text contains invalid Unicode.",
    );
    const length = encoder.encode(value).length;
    requireValid(length <= max, "Report text exceeds the byte limit.");
    textBudget -= length;
    requireValid(textBudget >= 0, "Report exceeds the text budget.");
    return value;
  }
  function charge(count: number): void {
    rowBudget -= count;
    requireValid(rowBudget >= 0, "Report exceeds the row limit.");
  }
  const metadata = object(report.metadata, 7);
  const result: PulseReport = {
    version: 1,
    metadata: {
      quarkVersion: text(metadata.quark_version, 4096),
      phpVersion: text(metadata.php_version, 4096),
      platform: text(metadata.platform, 4096),
      cpuThreads: Number(integer(metadata.cpu_threads, 0n, 65_536n)),
      createdUnixMs: integer(metadata.created_unix_ms),
      plugins: list(metadata.plugins, 1024).map((value) => {
        const plugin = object(value, 2);
        return {
          name: text(plugin.name, 256),
          version: text(plugin.version, 256),
        };
      }),
      worlds: list(metadata.worlds, 4096).map((world) => text(world, 256)),
    },
    threads: [],
  };
  const names = new Set<string>();
  for (const value of list(report.threads, 128)) {
    const raw = object(value, 20);
    const name = text(raw.thread, 256);
    requireValid(!names.has(name), "Duplicate thread name.");
    names.add(name);
    const startedNs = integer(raw.started_ns);
    const endedNs = integer(raw.ended_ns, startedNs);
    requireValid(typeof raw.recording === "boolean", "Invalid recording state.");
    const tickCount = integer(raw.tick_count);
    const tickTotalNs = integer(raw.tick_total_ns);
    const tickMaxNs = integer(raw.tick_max_ns, 0n, tickTotalNs);
    const tickCapacity = Number(integer(raw.tick_capacity, 1n, 4096n));
    const maxSpikes = Number(integer(raw.max_spikes, 1n, 128n));
    const spikeThresholdNs = integer(raw.spike_threshold_ns, 0n, 60_000_000_000n);
    const zones = list(raw.zones, 4096).map((zone) => text(zone, 256));
    requireValid(new Set(zones).size === zones.length, "Duplicate zone name.");
    const rows = list(raw.nodes, 16_384);
    const active = list(raw.active_ticks, 16_384);
    requireValid(rows.length === active.length, "Active tick counters do not match nodes.");
    charge(rows.length);
    const nodes: PulseNode[] = rows.map((value, index) => {
      const [id, zone, parent, calls, total, self, max] = tuple(value, 7) as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      requireValid(
        id === BigInt(index + 1) && zone < BigInt(zones.length) && parent < id,
        "Invalid node hierarchy or zone reference.",
      );
      requireValid(
        self <= total && max <= total && (calls !== 0n || total === 0n),
        "Invalid node measurements.",
      );
      const activeLimit = raw.recording && tickCount < MAX_INT ? tickCount + 1n : tickCount;
      return {
        id: Number(id),
        zone: Number(zone),
        parent: Number(parent),
        calls,
        totalNs: total,
        selfNs: self,
        maxNs: max,
        activeTicks: integer(active[index], 0n, calls < activeLimit ? calls : activeLimit),
      };
    });
    function tick(value: unknown): PulseTick {
      const [id, offset, duration] = tuple(value, 3) as [bigint, bigint, bigint];
      const length = endedNs - startedNs;
      requireValid(
        id >= 1n &&
          id <= tickCount &&
          offset <= length &&
          duration <= length - offset &&
          duration <= tickMaxNs,
        "Invalid tick bounds or duration.",
      );
      return { id, offsetNs: offset, durationNs: duration };
    }
    const ticks = list(raw.ticks, tickCapacity).map(tick);
    requireValid(
      BigInt(ticks.length) ===
        (tickCount < BigInt(tickCapacity) ? tickCount : BigInt(tickCapacity)),
      "Tick history length does not match capture.",
    );
    charge(ticks.length);
    let previousEnd = 0n;
    let sum = 0n;
    for (const [index, item] of ticks.entries()) {
      requireValid(
        item.id === tickCount - BigInt(ticks.length) + BigInt(index + 1) &&
          item.offsetNs >= previousEnd &&
          item.durationNs <= tickTotalNs - sum,
        "Invalid tick ordering or total.",
      );
      previousEnd = item.offsetNs + item.durationNs;
      sum += item.durationNs;
    }
    let previousId = 0n;
    let spikeRows = 0;
    const spikes = list(raw.spikes, maxSpikes).map((value) => {
      const rawSpike = object(value, 2);
      const spikeTick = tick(rawSpike.tick);
      requireValid(
        spikeTick.id > previousId &&
          spikeThresholdNs > 0n &&
          spikeTick.durationNs > spikeThresholdNs,
        "Invalid spike threshold or ordering.",
      );
      previousId = spikeTick.id;
      const historyIndex = spikeTick.id - (tickCount - BigInt(ticks.length) + 1n);
      if (historyIndex >= 0n) {
        const match = ticks[Number(historyIndex)];
        requireValid(
          match !== undefined &&
            match.offsetNs === spikeTick.offsetNs &&
            match.durationNs === spikeTick.durationNs,
          "Spike disagrees with tick history.",
        );
      }
      const details = list(rawSpike.nodes, nodes.length);
      charge(details.length);
      spikeRows += details.length;
      requireValid(spikeRows <= 65_536, "Spike storage exceeds the row limit.");
      const seen = new Set<number>();
      return {
        tick: spikeTick,
        nodes: details.map((value) => {
          const [id, calls, total, self] = tuple(value, 4) as [bigint, bigint, bigint, bigint];
          const node = id <= BigInt(nodes.length) ? nodes[Number(id) - 1] : undefined;
          requireValid(
            node !== undefined && !seen.has(node.id),
            "Invalid or duplicate spike node reference.",
          );
          requireValid(
            calls >= 1n &&
              calls <= node.calls &&
              total <= node.totalNs &&
              total <= spikeTick.durationNs &&
              self <= total &&
              self <= node.selfNs,
            "Invalid spike node measurements.",
          );
          seen.add(node.id);
          return { id: node.id, calls, totalNs: total, selfNs: self };
        }),
      };
    });
    charge(spikes.length);
    const thread: PulseThread = {
      name,
      startedNs,
      endedNs,
      recording: raw.recording,
      zones,
      nodes,
      ticks,
      tickCount,
      tickTotalNs,
      tickMaxNs,
      tickCapacity,
      spikes,
      maxSpikes,
      spikeThresholdNs,
      durationNs: integer(raw.duration_ns, 0n, 86_400_000_000_000n),
      spikesDropped: integer(raw.spikes_dropped),
      unbalancedScopes: integer(raw.unbalanced_scopes),
      droppedScopes: integer(raw.dropped_scopes),
      unbalancedTicks: integer(raw.unbalanced_ticks),
    };
    result.threads.push(thread);
  }
  return result;
}
