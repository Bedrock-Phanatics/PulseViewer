import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PulseReport } from "../src/model/report.ts";
import { analyze, compare, elapsed, percent, treeRows } from "../src/analysis.ts";
import { parseInWorker } from "../src/parser/load.ts";
import { MAX_BYTES, parseReport, ReportError } from "../src/parser/qpulse.ts";
import { createShareLink, MAX_SHARE_BYTES, readShareLink } from "../src/share.ts";

const gzip = readFileSync(new URL("./fixtures/quark-v1.qpulse", import.meta.url));
const fixture = gunzipSync(gzip).toString("utf8");

test("share links preserve captures, filenames and precision under a Pages subpath", async () => {
  for (const content of [gzip, fixture]) {
    const file = new File([buffer(content)], "capture with spaces 😀.qpulse");
    const url = new URL(
      await createShareLink(file, "https://example.com/PulseViewer/?old=1#old", true),
    );
    assert.equal(url.pathname, "/PulseViewer/");
    assert.equal(url.search, "");
    const capture = readShareLink(url.hash);
    assert.ok(capture);
    assert.equal(capture.file.name, file.name);
    assert.equal(capture.sample, true);
    assert.deepEqual(
      await parseReport(await capture.file.arrayBuffer()),
      await parseReport(buffer(gzip)),
    );
    if (typeof content !== "string")
      assert.deepEqual(new Uint8Array(await capture.file.arrayBuffer()), Uint8Array.from(gzip));
  }
  const url = new URL(
    await createShareLink(new File([buffer(gzip)], "report.qpulse"), "https://example.com/", false),
  );
  assert.equal(readShareLink(url.hash)?.sample, false);
  assert.equal(readShareLink("#overview"), undefined);
});

test("share compression enforces byte limits before encoding", async () => {
  const bytes = new Uint8Array(MAX_SHARE_BYTES);
  bytes.set([0x1f, 0x8b]);
  const url = new URL(
    await createShareLink(new File([bytes], "boundary.qpulse"), "https://example.com/", false),
  );
  assert.equal(readShareLink(url.hash)?.file.size, MAX_SHARE_BYTES);
  for (const bytes of [
    buffer(new Uint8Array(MAX_BYTES + 1)),
    buffer(Buffer.concat([Buffer.from([0x1f, 0x8b]), randomBytes(MAX_SHARE_BYTES)])),
    buffer(randomBytes(MAX_SHARE_BYTES * 2)),
  ]) {
    await assert.rejects(
      createShareLink(new File([bytes], "large.qpulse"), "https://example.com/", false),
      /too large for a link/,
    );
  }
});

test("share links reject malformed, duplicate and oversized payloads", () => {
  const valid = `#pulse=v1.${gzip.toString("base64url")}`;
  for (const hash of [
    "#pulse=",
    "#pulse=v2.H4s",
    "#pulse=v1.A",
    "#pulse=v1.bad!",
    "#pulse=v1.e30",
    `${valid}&pulse=v1.H4s`,
    `${valid}&name=a&name=b`,
    `${valid}&sample=0`,
    `${valid}&extra=1`,
    `${valid}&name=${"a".repeat(161)}`,
    `#pulse=v1.${"A".repeat((MAX_SHARE_BYTES * 4) / 3 + 4)}`,
    `#pulse=v1.${"A".repeat(MAX_SHARE_BYTES * 2)}`,
  ])
    assert.throws(() => readShareLink(hash), ReportError);
});

test("analysis separates full-session counters from retained history and preserves call paths", async () => {
  const report = await parseReport(buffer(gzip));
  const thread = report.threads[0];
  assert.ok(thread);
  const result = analyze(thread);
  assert.equal(thread.tickTotalNs / thread.tickCount, 42_500_000n);
  assert.equal(thread.tickMaxNs, 80_000_000n);
  assert.equal(result.p95, 60_000_000n);
  assert.equal(result.p99, 60_000_000n);
  assert.equal(result.selfNs, 170_000_000n);
  assert.equal(result.rootNs, 170_000_000n);
  assert.equal(result.hotspots[0]?.name, "event.SkyWars.PlayerMoveEvent");
  assert.equal(percent(result.hotspots[0]?.selfNs ?? 0n, result.selfNs), 50);
  assert.equal(elapsed(thread), "0.37 s");
  assert.deepEqual(
    treeRows(thread, result, new Set([1]), "totalNs", "").map((row) => row.node.id),
    [1],
  );
  assert.deepEqual(
    treeRows(thread, result, new Set([1]), "totalNs", "playermove").map((row) => row.node.id),
    [1, 3, 4],
  );
  assert.deepEqual(
    treeRows(thread, result, new Set(), "totalNs", "").map((row) => row.node.id),
    [1, 3, 4, 2],
  );
  assert.ok(result.spikes.has(2n));
  assert.ok(!thread.ticks.some((tick) => tick.id === 2n));
  const worker = report.threads[1];
  assert.ok(worker);
  assert.equal(analyze(worker).p95, undefined);
  assert.equal(percent(10n, 0n), 0);
});

test("recursive hotspot totals remain inclusive, self time additive, and averages sort without precision loss", async () => {
  const live = await parseReport(
    buffer(readFileSync(new URL("./fixtures/live-v1.qpulse", import.meta.url))),
  );
  const thread = live.threads[0];
  assert.ok(thread);
  const result = analyze(thread);
  assert.equal(result.hotspots.length, 1);
  assert.equal(result.hotspots[0]?.totalNs, 10n);
  assert.equal(result.hotspots[0]?.selfNs, 10n);
  assert.equal(result.hotspots[0]?.calls, 1n);
  assert.equal(result.rootNs, 0n);
  assert.deepEqual(
    treeRows(thread, result, new Set(), "totalNs", "recursive").map((row) => row.depth),
    [0, 1],
  );
  const a = { name: "a", totalNs: 9_007_199_254_740_993n, selfNs: 0n, maxNs: 0n, calls: 1n };
  assert.equal(compare(a, { ...a, totalNs: a.totalNs - 1n }, "average"), -1);
});
const rawJSON = Reflect.get(JSON, "rawJSON") as (text: string) => unknown;
type RawThread = Record<string, unknown> & {
  nodes: bigint[][];
  active_ticks: bigint[];
  zones: string[];
  ticks: bigint[][];
  spikes: { tick: bigint[]; nodes: bigint[][] }[];
};
type RawReport = Record<string, unknown> & {
  metadata: Record<string, unknown>;
  threads: RawThread[];
};

function buffer(value: string | Uint8Array): ArrayBuffer {
  return Uint8Array.from(typeof value === "string" ? Buffer.from(value) : value).buffer;
}

function changed(edit: (report: RawReport, thread: RawThread) => void): string {
  const report = JSON.parse(
    fixture,
    (_key: string, value: unknown, context?: { source: string }) => {
      if (typeof value !== "number") return value;
      assert.ok(context);
      return BigInt(context.source);
    },
  ) as RawReport;
  const thread = report.threads[0];
  assert.ok(thread);
  edit(report, thread);
  return JSON.stringify(report, (_key, value) =>
    typeof value === "bigint" ? rawJSON(String(value)) : value,
  );
}

async function rejects(value: string | Uint8Array, pattern?: RegExp): Promise<void> {
  await assert.rejects(parseReport(buffer(value)), (error: unknown) => {
    assert.ok(error instanceof ReportError);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("Quark encoder fixtures normalize identically from plain and gzip", async () => {
  const plain = await parseReport(buffer(fixture));
  assert.deepEqual(await parseReport(buffer(gzip)), plain);
  assert.equal(plain.version, 1);
  assert.equal(plain.metadata.quarkVersion, "6.0.0");
  assert.deepEqual(plain.metadata.plugins, [{ name: "SkyWars", version: "1.0" }]);
  const main = plain.threads[0];
  const worker = plain.threads[1];
  assert.ok(main && worker);
  assert.equal(main.startedNs, 9_007_199_254_740_993n);
  assert.equal(main.tickCount, 4n);
  assert.equal(main.tickTotalNs, 170_000_000n);
  assert.equal(main.nodes[0]?.selfNs, 42_500_000n);
  assert.equal(main.nodes[0]?.activeTicks, 4n);
  assert.deepEqual(
    main.ticks.map((tick) => tick.id),
    [3n, 4n],
  );
  assert.deepEqual(
    main.spikes.map((spike) => spike.tick.id),
    [2n, 4n],
  );
  assert.equal(worker.tickCount, 0n);
  assert.equal(worker.nodes[0]?.totalNs, 10n);
});

test("empty reports and unfinished live parents are valid", async () => {
  const empty = readFileSync(new URL("./fixtures/empty-v1.qpulse", import.meta.url));
  assert.deepEqual((await parseReport(buffer(empty))).threads, []);
  const live = readFileSync(new URL("./fixtures/live-v1.qpulse", import.meta.url));
  const thread = (await parseReport(buffer(live))).threads[0];
  assert.ok(thread);
  assert.equal(thread.recording, true);
  assert.equal(thread.nodes[0]?.totalNs, 0n);
  assert.equal(thread.nodes[1]?.totalNs, 10n);
  assert.equal(thread.nodes[1]?.activeTicks, 1n);
  assert.equal(thread.tickCount, 0n);
});

test("all integer row positions reject wrong types, floats, negatives and overflow", async () => {
  const rows = [
    "[1,0,0,4,170000000,42500000,80000000]",
    "[3,190000000,20000000]",
    "[1,1,80000000,20000000]",
  ];
  for (const row of rows) {
    assert.ok(fixture.includes(row), row);
    const values = row.slice(1, -1).split(",");
    for (let i = 0; i < values.length; i++) {
      for (const invalid of [
        "true",
        "false",
        "null",
        '"1"',
        "1.0",
        "1e0",
        "-1",
        "[]",
        "{}",
        "9223372036854775808",
      ]) {
        const replacement = [...values];
        replacement[i] = invalid;
        await rejects(fixture.replace(row, `[${replacement.join(",")}]`));
      }
    }
  }
});

test("64-bit integer maximum is preserved", async () => {
  const report = await parseReport(
    buffer(
      changed((_report, thread) => {
        const node = thread.nodes[0];
        assert.ok(node);
        node[3] = 9_223_372_036_854_775_807n;
      }),
    ),
  );
  assert.equal(report.threads[0]?.nodes[0]?.calls, 9_223_372_036_854_775_807n);
});

test("format, fields, lists, counters and references are validated", async () => {
  const invalid: Record<string, Record<string, unknown[]>> = {
    report: { version: [2n, "1"], time_unit: ["ms"], extra: [[]] },
    metadata: {
      extra: [0n],
      worlds: [{}, { 0: "Lobby" }],
      cpu_threads: [65_537n],
      plugins: [[{ name: "plugin" }]],
    },
    thread: {
      thread: [""],
      recording: ["false"],
      ended_ns: [99n],
      tick_capacity: [0n],
      max_spikes: [129n],
      spike_threshold_ns: [0n, 80_000_000n, 60_000_000_001n],
      duration_ns: [86_400_000_000_001n],
      zones: [["zone", "zone"], ["😀".repeat(65)], ["\ud800"]],
      active_ticks: [[], [5n, 4n, 4n, 4n], { 0: 1n }],
      tick_total_ns: [1n],
      ticks: [
        [
          [4n, 260000000n, 60000000n],
          [3n, 190000000n, 20000000n],
        ],
        [[3n, 190000000n, 20000000n]],
        [
          [3n, 190000000n, 20000000n],
          [4n, 0n, 60000000n],
        ],
        [
          [3n, 190000000n, 20000000n],
          [4n, 1000000000n, 60000000n],
        ],
      ],
    },
  };
  for (const [scope, fields] of Object.entries(invalid)) {
    for (const [key, values] of Object.entries(fields)) {
      for (const value of values) {
        await rejects(
          changed((report, thread) => {
            const target =
              scope === "report" ? report : scope === "metadata" ? report.metadata : thread;
            target[key] = value;
          }),
        );
      }
    }
  }
  for (const row of [
    [2n, 0n, 0n, 4n, 170000000n, 0n, 80000000n],
    [1n, 4n, 0n, 4n, 170000000n, 0n, 80000000n],
    [1n, 0n, 1n, 4n, 170000000n, 0n, 80000000n],
    [1n, 0n, 0n, 0n, 170000000n, 0n, 80000000n],
    [1n, 0n, 0n, 4n, 170000000n, 170000001n, 80000000n],
    [1n, 0n, 0n, 4n, 170000000n, 0n, 170000001n],
    [1n],
  ]) {
    await rejects(
      changed((_report, thread) => {
        thread.nodes[0] = row;
      }),
    );
  }
  for (const nodes of [
    [[0n, 1n, 1n, 0n]],
    [[1n, 5n, 1n, 0n]],
    [[1n, 1n, 80000001n, 0n]],
    [[1n, 1n, 1n, 2n]],
    [
      [1n, 1n, 1n, 0n],
      [1n, 1n, 1n, 0n],
    ],
  ]) {
    await rejects(
      changed((_report, thread) => {
        thread.spikes[0] = { tick: [2n, 60000000n, 80000000n], nodes };
      }),
    );
  }
  await rejects(
    changed((report, thread) => {
      report.threads.push(thread);
    }),
  );
  await rejects(
    changed((_report, thread) => {
      thread.spikes.reverse();
    }),
  );
  await rejects(
    changed((_report, thread) => {
      thread.spikes[1] = { tick: [4n, 260000000n, 59000000n], nodes: [] };
    }),
  );
});

test("JSON structure, encoding and pre-parse budgets reject hostile input", async () => {
  for (const invalid of [
    "",
    "[]",
    "{}",
    "null",
    fixture.slice(0, -1),
    `${"[".repeat(17)}0${"]".repeat(17)}`,
    '"unfinished\\',
    "\0[0]",
    `\ufeff${fixture}`,
  ]) {
    await rejects(invalid);
  }
  await rejects(new Uint8Array([0xff]), /UTF-8/);
  await rejects(" ".repeat(MAX_BYTES + 1), /8 MiB/);
  await rejects(`[${"[],".repeat(300_000)}[]]`, /container/);
  await rejects(`[${"0,".repeat(1_500_001)}0]`, /value/);
  await rejects(fixture.replace('"version":1', '"version":1,"version":2'));
  for (const value of ["{}", "null", '"hidden"']) {
    await rejects(fixture.replace('"format":', `"__proto__":${value},"format":`));
  }
});

test("gzip rejects truncation, CRC corruption, trailing bytes and concatenated streams", async () => {
  const corrupt = Buffer.from(gzip);
  const index = corrupt.length - 8;
  corrupt[index] = (corrupt[index] ?? 0) ^ 0xff;
  for (const invalid of [
    Buffer.from([0x1f, 0x8b]),
    gzip.subarray(0, -1),
    corrupt,
    gzipSync("{}"),
    Buffer.concat([gzip, Buffer.from("garbage")]),
    Buffer.concat([gzip, gzip]),
  ]) {
    await rejects(invalid);
  }
});

test("gzip inflation is bounded, including the exact size boundary", async () => {
  const maximum = fixture + " ".repeat(MAX_BYTES - Buffer.byteLength(fixture));
  assert.equal((await parseReport(buffer(gzipSync(maximum)))).threads.length, 2);
  await rejects(gzipSync(" ".repeat(MAX_BYTES + 1)), /Decompressed/);
  await rejects(gzipSync(" ".repeat(MAX_BYTES * 4)), /Decompressed/);
});

test("aggregate row and text budgets are bounded across threads", async () => {
  await rejects(
    changed((report, thread) => {
      thread.nodes = Array.from({ length: 16_384 }, (_, i) => [
        BigInt(i + 1),
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
      ]);
      thread.active_ticks = Array(16_384).fill(0n);
      thread.spikes = [];
      report.threads = Array.from({ length: 8 }, (_, i) => ({
        ...thread,
        thread: `thread-${i}`,
      }));
    }),
    /row limit/,
  );
  await rejects(
    changed((report, thread) => {
      thread.nodes = [];
      thread.active_ticks = [];
      thread.spikes = [];
      thread.zones = Array.from({ length: 4096 }, (_, i) => String(i).padStart(256, "x"));
      report.threads = Array.from({ length: 4 }, (_, i) => ({
        ...thread,
        thread: `thread-${i}`,
      }));
    }),
    /text budget/,
  );
});

test("per-thread spike storage is bounded separately from the global row budget", async () => {
  await rejects(
    changed((report, thread) => {
      report.threads = [thread];
      thread.started_ns = 0n;
      thread.ended_ns = 256n;
      thread.tick_count = 128n;
      thread.tick_total_ns = 256n;
      thread.tick_max_ns = 2n;
      thread.tick_capacity = 1n;
      thread.max_spikes = 128n;
      thread.spike_threshold_ns = 1n;
      thread.ticks = [[128n, 254n, 2n]];
      thread.nodes = Array.from({ length: 513 }, (_, i) => [
        BigInt(i + 1),
        0n,
        0n,
        128n,
        256n,
        256n,
        2n,
      ]);
      thread.active_ticks = Array(513).fill(128n);
      thread.spikes = Array.from({ length: 128 }, (_, i) => ({
        tick: [BigInt(i + 1), BigInt(i * 2), 2n],
        nodes: Array.from({ length: 513 }, (_, j) => [BigInt(j + 1), 1n, 2n, 2n]),
      }));
    }),
    /Spike storage/,
  );
});

test("punctuation inside strings does not consume JSON container budget", async () => {
  const text = changed((_report, thread) => {
    thread.zones = Array.from({ length: 2000 }, (_, i) => `zone\\"${"[".repeat(240)}${i}`);
  });
  assert.equal((await parseReport(buffer(text))).threads[0]?.zones.length, 2000);
});

test("repeated parsing produces independent reports", async () => {
  const first = await parseReport(buffer(gzip));
  for (let i = 0; i < 20; i++) {
    const next = await parseReport(buffer(gzip));
    assert.deepEqual(next, first);
    assert.notEqual(next.threads, first.threads);
  }
});

test("worker success, errors, transfer failures and timeouts always terminate", async (context) => {
  const original = globalThis.Worker;
  const workers: StubWorker[] = [];
  let failTransfer = false;
  class StubWorker {
    onmessage: ((event: { data: { report?: PulseReport; error?: string } }) => void) | null = null;
    onerror: ((event: { preventDefault(): void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    constructor() {
      workers.push(this);
    }
    postMessage() {
      if (failTransfer) throw new Error("Transfer failed");
    }
    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = StubWorker as unknown as typeof Worker;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sample = await parseReport(buffer(fixture));
    const success = parseInWorker(new ArrayBuffer(0));
    workers.at(-1)?.onmessage?.({ data: { report: sample } });
    assert.equal(await success, sample);
    assert.equal(workers.at(-1)?.terminated, true);
    for (const failure of ["report", "start", "message", "timeout"] as const) {
      const result = parseInWorker(new ArrayBuffer(0));
      const rejected = assert.rejects(result, ReportError);
      const worker = workers.at(-1);
      assert.ok(worker);
      if (failure === "report") worker.onmessage?.({ data: { error: "Invalid report" } });
      if (failure === "start") worker.onerror?.({ preventDefault() {} });
      if (failure === "message") worker.onmessageerror?.();
      if (failure === "timeout") context.mock.timers.tick(30_000);
      await rejected;
      assert.equal(worker.terminated, true, failure);
    }
    failTransfer = true;
    await assert.rejects(parseInWorker(new ArrayBuffer(0)), /Transfer failed/);
    assert.equal(workers.at(-1)?.terminated, true);
    assert.equal(workers.length, 6);
  } finally {
    context.mock.timers.reset();
    globalThis.Worker = original;
  }
});
