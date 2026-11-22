import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseReport } from "../src/parser/qpulse.ts";
import {
  analyze,
  asyncProfile,
  pluginProfile,
  resourceActivity,
  treeRows,
} from "../src/analysis.ts";

const fixture = gunzipSync(
  readFileSync(new URL("../tests/fixtures/quark-v1.qpulse", import.meta.url)),
).toString("utf8");
const rawJSON = Reflect.get(JSON, "rawJSON") as (text: string) => unknown;
const raw = JSON.parse(fixture, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value !== "number") return value;
  assert.ok(context);
  return BigInt(context.source);
}) as {
  threads: Record<string, unknown>[];
};
const thread = raw.threads[0];
assert.ok(thread);
thread.nodes = Array.from({ length: 16_382 }, (_, i) => [BigInt(i + 1), 0n, 0n, 0n, 0n, 0n, 0n]);
thread.active_ticks = Array(16_382).fill(0n);
thread.spikes = [];
raw.threads = Array.from({ length: 8 }, (_, i) => ({
  ...thread,
  thread: `worker-${i}`,
}));
const large = JSON.stringify(raw, (_key, value) =>
  typeof value === "bigint" ? rawJSON(String(value)) : value,
);
const v4 = gunzipSync(
  readFileSync(new URL("../tests/fixtures/full-v4.qpulse", import.meta.url)),
).toString("utf8");
const v4Raw = JSON.parse(v4, (_key: string, value: unknown, context?: { source: string }) =>
  typeof value === "number" ? BigInt(context?.source ?? "0") : value,
) as { threads: Record<string, unknown>[] };
const v4Main = v4Raw.threads[0];
assert.ok(v4Main);
// wrapped 1,200 samples and 16,384 plugin-owned paths
const v4Length = 86_400_000_000_000n;
v4Main.ended_ns = (v4Main.started_ns as bigint) + v4Length;
(v4Main.network as { coverage: Record<string, bigint> }).coverage.to_ns = v4Length;
v4Main.resources = {
  samples_dropped: 100n,
  samples: Array.from({ length: 1200 }, (_, i) => [
    v4Length - BigInt(1199 - i) * 1_000_000_000n,
    1_000_000_000n,
    500_000_000n,
    100_000_000n,
    64n * 1_048_576n,
    128n * 1_048_576n,
    512n * 1_048_576n,
    600n * 1_048_576n,
  ]),
};
v4Main.zones = Array.from({ length: 64 }, (_, i) => `plugin.P${i % 8}.${i}`);
v4Main.zone_owners = Array.from({ length: 64 }, (_, i) => [BigInt(i), `P${i % 8}`]);
v4Main.nodes = Array.from({ length: 16_384 }, (_, i) => [
  BigInt(i + 1),
  BigInt(i % 64),
  BigInt(i < 8 ? 0 : Math.floor(i / 2)),
  1n,
  2n,
  1n,
  2n,
]);
v4Main.active_ticks = Array(16_384).fill(0n);
v4Main.spikes = [];
v4Main.tick_count = 0n;
v4Main.tick_total_ns = 0n;
v4Main.tick_max_ns = 0n;
v4Main.slow_tick_count = 0n;
v4Main.ticks = [];
const v4Large = JSON.stringify(v4Raw, (_key, value) =>
  typeof value === "bigint" ? rawJSON(String(value)) : value,
);
for (const [label, json] of [
  ["Quark fixture", fixture],
  ["131,072 rows", large],
  ["v4 fixture", v4],
  ["v4 wrapped resources, 16,384 owned paths", v4Large],
] as const) {
  const buffer = Uint8Array.from(Buffer.from(json)).buffer;
  await parseReport(buffer);
  const times = [];
  const analysisTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const report = await parseReport(buffer);
    times.push(performance.now() - start);
    const analysisStart = performance.now();
    for (const thread of report.threads) {
      const data = analyze(thread);
      treeRows(thread, data, new Set(), "totalNs", "");
      pluginProfile(thread);
      if (thread.resources) resourceActivity(thread.resources);
    }
    asyncProfile(report);
    analysisTimes.push(performance.now() - analysisStart);
  }
  times.sort((a, b) => a - b);
  analysisTimes.sort((a, b) => a - b);
  console.log(
    `${label}: ${buffer.byteLength.toLocaleString()} bytes, parse median ${times[2]?.toFixed(1)} ms, analysis + tree median ${analysisTimes[2]?.toFixed(1)} ms (5 runs)`,
  );
}
