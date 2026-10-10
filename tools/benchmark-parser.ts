import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseReport } from "../src/parser/qpulse.ts";
import { analyze, treeRows } from "../src/analysis.ts";

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
for (const [label, json] of [
  ["Quark fixture", fixture],
  ["131,072 rows", large],
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
    }
    analysisTimes.push(performance.now() - analysisStart);
  }
  times.sort((a, b) => a - b);
  analysisTimes.sort((a, b) => a - b);
  console.log(
    `${label}: ${buffer.byteLength.toLocaleString()} bytes, parse median ${times[2]?.toFixed(1)} ms, analysis + tree median ${analysisTimes[2]?.toFixed(1)} ms (5 runs)`,
  );
}
