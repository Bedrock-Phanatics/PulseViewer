import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  asyncProfile,
  formatBytes,
  orderedCounters,
  pluginProfile,
  resourceActivity,
  signedBytes,
} from "../src/analysis.ts";
import type { PulseReport, PulseThread } from "../src/model/report.ts";
import { parseReport, ReportError } from "../src/parser/qpulse.ts";
import { newState, tableBody, visibleRows, type TableConfig } from "../src/table.ts";
import { html } from "../src/ui.ts";

const MIB = 1_048_576n;
const rawJSON = Reflect.get(JSON, "rawJSON") as (text: string) => unknown;
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}.qpulse`, import.meta.url));
const buffer = (value: string | Uint8Array) =>
  Uint8Array.from(typeof value === "string" ? Buffer.from(value) : value).buffer;
const load = (name: string) => parseReport(buffer(read(name)));
const plain = (name: string) => gunzipSync(read(name)).toString("utf8");

type Raw = Record<string, unknown> & { threads: Record<string, unknown>[] };

/** edits a fixture keeping exact 64-bit integers */
function changed(edit: (report: Raw, main: Record<string, unknown>) => void, name = "full-v4") {
  const report = JSON.parse(
    plain(name),
    (_key: string, value: unknown, context?: { source: string }) => {
      if (typeof value !== "number") return value;
      assert.ok(context);
      return BigInt(context.source);
    },
  ) as Raw;
  const main = report.threads[0];
  assert.ok(main);
  edit(report, main);
  return JSON.stringify(report, (_key, value) =>
    typeof value === "bigint" ? rawJSON(String(value)) : value,
  );
}

async function rejects(value: string, pattern?: RegExp) {
  await assert.rejects(parseReport(buffer(value)), (error: unknown) => {
    assert.ok(error instanceof ReportError, String(error));
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const thread = (report: PulseReport, name: string): PulseThread => {
  const found = report.threads.find((item) => item.name === name);
  assert.ok(found, name);
  return found;
};

test("Quark v4 encoder output parses from gzip and plain JSON identically", async () => {
  const report = await load("full-v4");
  assert.deepEqual(await parseReport(buffer(plain("full-v4"))), report);
  assert.equal(report.version, 4);
  assert.deepEqual(
    report.threads.map((item) => item.name),
    ["main", "worker#1", "worker#2", "worker#3"],
  );
  assert.equal(report.metadata.plugins.length, 2);
  const main = thread(report, "main");
  assert.equal(main.startedNs, 9_007_199_254_740_993n); // beyond Number.MAX_SAFE_INTEGER
  assert.equal(main.endedNs - main.startedNs, 4_000_000_000n);
  assert.equal(main.tickCount, 3n);
  assert.equal(main.slowTickCount, 1n);
});

test("v4 resource samples keep eight values, nullable CPU and nullable RSS", async () => {
  const main = thread(await load("full-v4"), "main");
  assert.ok(main.resources);
  assert.equal(main.resources.hasRss, true);
  assert.equal(main.resources.samples.length, 5);
  const [first, , third, fourth, fifth] = main.resources.samples;
  assert.ok(first && third && fourth && fifth);
  assert.equal(first.rssBytes, 512n * MIB);
  assert.equal(first.rssPeakBytes, 600n * MIB);
  assert.equal(first.cpuUserNs, null);
  assert.equal(third.rssPeakBytes, 620n * MIB);
  assert.equal(fourth.rssBytes, null);
  assert.equal(fourth.rssPeakBytes, null);
  assert.equal(fourth.cpuUserNs, null);
  assert.equal(fifth.rssBytes, 530n * MIB);
  assert.equal(thread(await load("full-v4"), "worker#1").resources, null);
});

test("v4 reports zone owners, async objects and transports on every thread", async () => {
  const report = await load("full-v4");
  const main = thread(report, "main");
  assert.deepEqual(
    main.zoneOwners?.map((owner) => [main.zones[owner.zone], owner.plugin]),
    [
      ["plugin.SkyWars", "SkyWars"],
      ["event.SkyWars.PlayerMoveEvent", "SkyWars"],
      ["event.Economy.BalanceEvent", "Economy"],
      ["plugin.Economy", "Economy"],
    ],
  );
  assert.deepEqual(thread(report, "worker#1").zoneOwners, []);
  assert.deepEqual(main.async, {
    submitted: 12n,
    completed: 11n,
    queuePeak: 5n,
    turnaroundTotalNs: 980_000_000n,
    turnaroundMaxNs: 140_000_000n,
    pickupTotalNs: 320_000_000n,
    pickupMaxNs: 80_000_000n,
    ran: 0n,
    waitTotalNs: 0n,
    waitMaxNs: 0n,
    runTotalNs: 0n,
    runMaxNs: 0n,
    heapBytes: 0n,
    heapPeakBytes: 0n,
  });
  const worker = thread(report, "worker#1").async;
  assert.equal(worker?.ran, 4n);
  assert.equal(worker?.waitTotalNs, 52_000_000n);
  assert.equal(worker?.waitMaxNs, 40_000_000n);
  assert.equal(worker?.runTotalNs, 100_000_000n);
  assert.equal(worker?.heapBytes, 16n * MIB);
  assert.equal(worker?.heapPeakBytes, 24n * MIB);
  assert.equal(worker?.submitted, 0n);
  const transports = main.network?.transports;
  assert.deepEqual(
    transports?.map((item) => item.name),
    ["raklib", "bedwire"],
  );
  const bedwire = new Map(transports?.[1]?.counters.map((c) => [c.name, c.value]));
  assert.equal(bedwire.get("bytes_sent"), 5_242_880n);
  assert.equal(bedwire.get("sessions_peak"), 24n);
  assert.equal(bedwire.get("command_queue_peak_bytes"), 262_144n);
  assert.equal(bedwire.get("future_widget_count"), 7n);
  assert.equal(bedwire.has("sessions"), false);
});

test("an unmodified capture from Quark's recorder, with real sampling, parses", async () => {
  const report = await load("real-v4");
  assert.equal(report.version, 4);
  const main = thread(report, "main");
  assert.equal(main.tickCount, 48n);
  assert.ok(main.resources && main.resources.samples.length >= 2);
  for (const sample of main.resources.samples)
    assert.equal(sample.rssBytes === null, sample.rssPeakBytes === null);
  assert.deepEqual(
    main.zoneOwners?.map((owner) => owner.plugin),
    ["RealPlugin"],
  );
  assert.equal(main.async?.submitted, 48n);
  assert.equal(thread(report, "worker#1").async?.ran, 5n);
  const profile = pluginProfile(main);
  assert.equal(profile.plugins[0]?.name, "RealPlugin");
  assert.equal(profile.plugins[0]?.calls, 48n);
});

test("incomplete recordings, minimal captures, idle threads and empty reports parse", async () => {
  const incomplete = await load("incomplete-v4");
  assert.equal(
    incomplete.threads.every((item) => item.recording),
    true,
  );
  assert.equal(incomplete.threads[0]?.async?.submitted, 1n);
  assert.equal(incomplete.threads[0]?.async?.queuePeak, 2n);
  const minimal = await load("minimal-v4");
  const main = thread(minimal, "main");
  assert.equal(
    main.resources?.samples.every((sample) => sample.rssBytes === null),
    true,
  );
  assert.deepEqual(main.zoneOwners, []);
  assert.deepEqual(main.network?.transports, []);
  assert.equal(main.async?.submitted, 0n);
  assert.equal(thread(minimal, "worker#1").resources, null);
  const idle = await load("idle-v4");
  assert.equal(idle.threads[0]?.async, null);
  assert.equal(idle.threads[0]?.resources, null);
  assert.deepEqual((await load("empty-v4")).threads, []);
});

test("v1, v2 and v3 fixtures still parse without v4 fields", async () => {
  for (const [name, version] of [
    ["quark-v1", 1],
    ["network-v2", 2],
    ["resources-v3", 3],
  ] as const) {
    const report = await load(name);
    assert.equal(report.version, version);
    for (const item of report.threads) {
      assert.equal(item.zoneOwners, undefined);
      assert.equal(item.async, undefined);
      assert.equal(item.network?.transports, undefined);
    }
  }
  const v3 = thread(await load("resources-v3"), "main");
  assert.equal(v3.resources?.hasRss, false);
  assert.equal(v3.resources?.samples[1]?.rssBytes, null);
  assert.equal(pluginProfile(v3).status, "legacy");
});

test("version-dependent shapes are enforced in both directions", async () => {
  const v3 = plain("resources-v3");
  await rejects(v3.replace('"version":3', '"version":4'));
  await rejects(plain("full-v4").replace('"version":4', '"version":3'));
  await rejects(plain("full-v4").replace('"version":4', '"version":5'));
  // 6 columns are invalid in v4, 8 are invalid in v3
  await rejects(
    changed((_report, main) => {
      const resources = main.resources as { samples: unknown[][] };
      resources.samples = resources.samples.map((row) => row.slice(0, 6));
    }),
  );
  await rejects(
    changed((_report, main) => {
      const resources = main.resources as { samples: unknown[][] };
      resources.samples = resources.samples.map((row) => [...row, null, null]);
    }, "resources-v3"),
  );
});

test("v4 validation rejects malformed resource RSS", async () => {
  const edit = (change: (row: unknown[]) => void) =>
    changed((_report, main) => {
      const rows = (main.resources as { samples: unknown[][] }).samples;
      const row = rows[1];
      assert.ok(row);
      change(row);
    });
  await rejects(
    edit((row) => (row[6] = null)),
    /RSS/,
  );
  await rejects(
    edit((row) => (row[7] = null)),
    /RSS/,
  );
  await rejects(
    edit((row) => (row[6] = 601n * MIB)),
    /integer/,
  );
  await rejects(
    edit((row) => (row[6] = -1n)),
    /integer/,
  );
  await rejects(
    edit((row) => (row[6] = "1")),
    /integer/,
  );
  await rejects(
    edit((row) => (row[7] = 9_223_372_036_854_775_808n)),
    /integer|64-bit/,
  );
});

test("zone_owners must be a list of ascending, unique, in-range rows with valid names", async () => {
  const owners = (rows: unknown) =>
    changed((_report, main) => {
      main.zone_owners = rows;
    });
  await rejects(
    changed((_report, main) => {
      delete main.zone_owners;
    }),
  );
  await rejects(owners(null));
  await rejects(
    owners([
      [1n, "A"],
      [1n, "B"],
    ]),
  );
  await rejects(
    owners([
      [2n, "A"],
      [1n, "B"],
    ]),
  );
  await rejects(owners([[6n, "A"]]));
  await rejects(owners([[-1n, "A"]]));
  await rejects(owners([[0n, ""]]));
  await rejects(owners([[0n, 5n]]));
  await rejects(owners([[0n, "A", "B"]]));
  await rejects(owners([[0n, "x".repeat(257)]]));
  await rejects(owners(Array.from({ length: 7 }, (_, i) => [BigInt(i), "A"])));
  await rejects(owners([[0n, "\ud800"]]), /Unicode|text/);
});

test("async data is validated for shape, totals and ordering", async () => {
  const edit = (change: (async: Record<string, unknown>) => void) =>
    changed((_report, main) => {
      change(main.async as Record<string, unknown>);
    });
  await rejects(edit((a) => (a.completed = 13n)));
  await rejects(edit((a) => (a.turnaround_max_ns = 980_000_001n)));
  await rejects(edit((a) => (a.pickup_max_ns = 320_000_001n)));
  await rejects(edit((a) => (a.wait_max_ns = 1n)));
  await rejects(edit((a) => (a.run_max_ns = 1n)));
  await rejects(edit((a) => (a.heap_bytes = 1n)));
  await rejects(edit((a) => (a.queue_peak = -1n)));
  await rejects(edit((a) => (a.ran = 1.5 as unknown as bigint)));
  await rejects(edit((a) => delete a.heap_peak_bytes));
  await rejects(edit((a) => (a.extra = 1n)));
  await rejects(
    changed((_report, main) => {
      delete main.async;
    }),
  );
  await rejects(
    changed((_report, main) => {
      main.async = [];
    }),
  );
  // null is valid for a context that never recorded
  assert.equal(
    (
      await parseReport(
        buffer(
          changed((_report, main) => {
            main.async = null;
          }),
        ),
      )
    ).threads[0]?.async,
    null,
  );
});

test("transport validation mirrors Quark's rules", async () => {
  const edit = (change: (network: Record<string, unknown>) => void) =>
    changed((_report, main) => {
      change(main.network as Record<string, unknown>);
    });
  const counters = (name: string, rows: unknown[]) => [{ name, counters: rows }];
  await rejects(edit((n) => delete n.transports));
  await rejects(edit((n) => (n.transports = null)));
  await rejects(edit((n) => (n.transports = counters("udp", []))));
  await rejects(
    edit((n) => (n.transports = [...counters("raklib", []), ...counters("raklib", [])])),
  );
  await rejects(
    edit(
      (n) =>
        (n.transports = [
          ...counters("raklib", []),
          ...counters("bedwire", []),
          ...counters("x", []),
        ]),
    ),
  );
  await rejects(edit((n) => (n.transports = [{ name: "raklib" }])));
  await rejects(edit((n) => (n.transports = [{ name: "raklib", counters: [], extra: 1n }])));
  for (const name of ["Upper", "1abc", "has-dash", "", "a".repeat(65), "spaced name"]) {
    await rejects(edit((n) => (n.transports = counters("raklib", [[name, 1n]]))));
  }
  await rejects(
    edit(
      (n) =>
        (n.transports = counters("raklib", [
          ["a", 1n],
          ["a", 2n],
        ])),
    ),
  );
  await rejects(edit((n) => (n.transports = counters("raklib", [["a", -1n]]))));
  await rejects(edit((n) => (n.transports = counters("raklib", [["a", "1"]]))));
  await rejects(edit((n) => (n.transports = counters("raklib", [["a"]]))));
  await rejects(
    edit(
      (n) =>
        (n.transports = counters(
          "raklib",
          Array.from({ length: 65 }, (_, i) => [`c${i}`, 0n]),
        )),
    ),
  );
  // the limits themselves are valid
  const report = await parseReport(
    buffer(
      edit(
        (n) =>
          (n.transports = counters("raklib", [
            ["a".repeat(64), 9_223_372_036_854_775_807n],
            ...Array.from({ length: 63 }, (_, i) => [`c${i}`, 0n]),
          ])),
      ),
    ),
  );
  assert.equal(
    report.threads[0]?.network?.transports?.[0]?.counters[0]?.value,
    9_223_372_036_854_775_807n,
  );
  assert.equal(report.threads[0]?.network?.transports?.[0]?.counters.length, 64);
});

test("v4 transport counters count toward the shared row budget", async () => {
  await rejects(
    changed((report, main) => {
      main.zone_owners = [];
      main.network = {
        ...(main.network as object),
        transports: [
          {
            name: "raklib",
            counters: Array.from({ length: 64 }, (_, i) => [`counter_${i}`, 0n]),
          },
        ],
      };
      main.resources = null;
      main.nodes = Array.from({ length: 16_384 }, (_, i) => [
        BigInt(i + 1),
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
      ]);
      main.active_ticks = Array(16_384).fill(0n);
      main.spikes = [];
      report.threads = Array.from({ length: 8 }, (_, i) => ({ ...main, thread: `t${i}` }));
    }),
    /row limit/,
  );
});

test("64-bit values stay exact and values above int64 are rejected", async () => {
  await rejects(
    changed((_report, main) => {
      (main.async as Record<string, unknown>).submitted = 9_223_372_036_854_775_808n;
    }),
  );
  const exact = await parseReport(
    buffer(
      changed((_report, main) => {
        const a = main.async as Record<string, unknown>;
        a.submitted = 9_223_372_036_854_775_807n;
        a.completed = 9_223_372_036_854_775_807n;
        a.turnaround_total_ns = 9_223_372_036_854_775_806n;
        a.turnaround_max_ns = 9_223_372_036_854_775_805n;
      }),
    ),
  );
  assert.equal(exact.threads[0]?.async?.completed, 9_223_372_036_854_775_807n);
  assert.equal(exact.threads[0]?.async?.turnaroundTotalNs, 9_223_372_036_854_775_806n);
});

test("plugin profiles never double count nested or recursive callbacks", async () => {
  const main = thread(await load("full-v4"), "main");
  const profile = pluginProfile(main);
  assert.equal(profile.status, "ok");
  const [sky, economy] = profile.plugins;
  assert.ok(sky && economy);
  assert.equal(sky.name, "SkyWars");
  // per tick: plugin.SkyWars 10 ms outermost, move event nested inside, plus a recursive call
  assert.equal(sky.totalNs, 30_000_000n);
  assert.equal(sky.calls, 3n);
  assert.equal(sky.maxNs, 10_000_000n);
  assert.equal(sky.selfNs, 24_000_000n);
  // economy runs inside skywars but is outermost for itself
  assert.equal(economy.totalNs, 12_000_000n);
  assert.equal(economy.calls, 6n);
  assert.equal(economy.selfNs, 12_000_000n);
  assert.equal(economy.maxNs, 2_000_000n);
  // self is additive, skywars total includes economy's nested self
  assert.equal(profile.ownedSelfNs, sky.selfNs + economy.selfNs);
  assert.ok(profile.ownedSelfNs <= profile.selfNs);
  assert.equal(sky.totalNs - sky.selfNs, 6_000_000n);
  const nested = sky.zones.find((zone) => zone.name === "event.SkyWars.PlayerMoveEvent");
  assert.equal(nested?.totalNs, 0n);
  assert.equal(nested?.calls, 6n);
});

test("plugin profile explains missing attribution", async () => {
  const minimal = thread(await load("minimal-v4"), "main");
  assert.equal(pluginProfile(minimal).status, "no-owners");
  assert.equal(pluginProfile(thread(await load("quark-v1"), "main")).status, "legacy");
  assert.equal(pluginProfile(thread(await load("full-v4"), "worker#1")).status, "no-owners");
});

test("a plugin owning a recursive zone counts only the outermost call", () => {
  const node = (id: number, zone: number, parent: number, total: bigint, self: bigint) => ({
    id,
    zone,
    parent,
    calls: 1n,
    totalNs: total,
    selfNs: self,
    maxNs: total,
    activeTicks: 1n,
  });
  const synthetic = {
    zones: ["a", "b"],
    zoneOwners: [
      { zone: 0, plugin: "P" },
      { zone: 1, plugin: "P" },
    ],
    // a(100) > b(60) > a(30), all owned by P, only the first counts
    nodes: [node(1, 0, 0, 100n, 40n), node(2, 1, 1, 60n, 30n), node(3, 0, 2, 30n, 30n)],
  } as unknown as PulseThread;
  const [row] = pluginProfile(synthetic).plugins;
  assert.equal(row?.totalNs, 100n);
  assert.equal(row?.selfNs, 100n);
  assert.equal(row?.calls, 1n);
});

test("async profile separates main-thread latency, worker utilization and idle workers", async () => {
  const profile = asyncProfile(await load("full-v4"));
  const byName = new Map(profile.rows.map((row) => [row.thread, row]));
  const main = byName.get("main");
  assert.equal(main?.role, "main");
  assert.equal(main?.avgTurnaroundNs, 89_090_909n);
  assert.equal(main?.avgPickupNs, 29_090_909n);
  assert.equal(main?.outstanding, 1n);
  assert.equal(byName.get("worker#1")?.busyPercent, 2.5);
  assert.equal(byName.get("worker#3")?.busyPercent, 87.5);
  assert.equal(byName.get("worker#3")?.avgWaitNs, 200_000_000n);
  const idle = byName.get("worker#2");
  assert.equal(idle?.hasWork, false);
  assert.equal(idle?.busyPercent, null);
  assert.equal(idle?.avgRunNs, undefined);
  assert.equal(profile.totals.workers, 3);
  assert.equal(profile.totals.idleWorkers, 1);
  assert.equal(profile.totals.ran, 11n);
  assert.equal(profile.totals.queuePeak, 5n);
  const titles = profile.findings.map((finding) => finding.title);
  assert.ok(titles.some((title) => /worker#3: 88% busy/.test(title)));
  // worker#3 waits 200 ms but runs 500 ms per task, busy not queue-bound
  assert.equal(
    titles.some((title) => /mostly waiting/.test(title)),
    false,
  );
  assert.ok(titles.some((title) => /1 task without/.test(title)));
  assert.equal(
    titles.some((title) => title.includes("worker#2")),
    false,
  );
});

test("pre-v4 and idle captures expose no async data", async () => {
  assert.deepEqual(asyncProfile(await load("resources-v3")).rows, []);
  assert.deepEqual(asyncProfile(await load("idle-v4")).rows, []);
  assert.equal(asyncProfile(await load("minimal-v4")).totals.ran, 0n);
});

test("resource activity derives RSS, growth and deltas and skips unavailable samples", async () => {
  const resources = thread(await load("full-v4"), "main").resources;
  assert.ok(resources);
  const activity = resourceActivity(resources);
  assert.equal(activity.cpuPeak, 200);
  assert.equal(activity.memoryGrowth, 12n * MIB);
  assert.equal(activity.rssCurrent, 530n * MIB);
  assert.equal(activity.rssGrowth, 18n * MIB);
  assert.equal(activity.rssProcessPeak, 620n * MIB);
  assert.equal(activity.rssAvailableSamples, 4);
  assert.equal(activity.samples[3]?.rssDelta, null);
  assert.equal(activity.samples[4]?.rssDelta, null); // the previous sample had no RSS
  assert.equal(activity.samples[3]?.memoryDelta, -24n * MIB);
  assert.equal(activity.samples[2]?.rssDelta, 20n * MIB);
  const none = resourceActivity(
    thread(await load("minimal-v4"), "main").resources ?? { samples: [] },
  );
  assert.equal(none.rssCurrent, null);
  assert.equal(none.rssGrowth, null);
  assert.equal(none.rssProcessPeak, null);
  assert.equal(resourceActivity({ samples: [] }).memoryGrowth, null);
});

test("transport counters keep documented order and render unknown counters last", async () => {
  const bedwire = thread(await load("full-v4"), "main").network?.transports?.[1];
  assert.ok(bedwire);
  const ordered = orderedCounters(bedwire);
  assert.equal(ordered[0]?.name, "bytes_sent");
  assert.equal(ordered.at(-1)?.name, "future_widget_count");
  const unknown = ordered.at(-1);
  assert.equal(unknown?.info.known, false);
  assert.equal(unknown?.info.label, "Future widget count");
  assert.equal(unknown?.info.kind, "count");
  assert.equal(ordered.find((item) => item.name === "sessions_peak")?.info.group, "peak");
});

test("byte formatting handles zero, signs and the 64-bit maximum", () => {
  assert.equal(formatBytes(0n), "0 B");
  assert.equal(formatBytes(1536n), "1.50 KiB");
  assert.equal(formatBytes(null), "—");
  assert.equal(signedBytes(-2n * MIB), "−2.00 MiB");
  assert.equal(signedBytes(2n * MIB), "+2.00 MiB");
  assert.match(formatBytes(9_223_372_036_854_775_807n), /EiB$/);
});

test("searchable tables sort with unavailable values last and page results", () => {
  const rows = [
    { name: "b", value: 2n },
    { name: "a", value: null },
    { name: "c", value: 3n },
    { name: "<x>", value: 1n },
  ];
  const config: TableConfig<(typeof rows)[number]> = {
    id: "t",
    label: "t",
    rows,
    defaultSort: "value",
    placeholder: "Search",
    empty: "none",
    search: (row) => row.name,
    pageSize: 2,
    columns: [
      { key: "name", label: "Name", text: true, value: (row) => row.name },
      { key: "value", label: "Value", value: (row) => row.value },
    ],
  };
  const state = newState(config);
  assert.deepEqual(
    visibleRows(config, state).map((row) => row.name),
    ["c", "b", "<x>", "a"],
  );
  state.descending = false;
  assert.deepEqual(
    visibleRows(config, state).map((row) => row.name),
    ["<x>", "b", "c", "a"],
  );
  state.query = "<X>";
  assert.deepEqual(
    visibleRows(config, state).map((row) => row.name),
    ["<x>"],
  );
  state.query = "";
  state.page = 9;
  const output = tableBody(config, state);
  assert.equal(state.page, 1);
  assert.match(output, /3–4 of 4|3–4/);
  assert.ok(!output.includes("<x>"), "untrusted values must be escaped");
  state.page = 0;
  state.query = "zzz";
  assert.match(tableBody(config, state), /none/);
});

test("untrusted report strings are escaped before reaching markup", async () => {
  const hostile = `<img src=x onerror=alert(1)>"'&`;
  const report = await parseReport(
    buffer(
      changed((_report, main) => {
        const owners = main.zone_owners as unknown[][];
        owners[0] = [owners[0]?.[0], hostile];
      }),
    ),
  );
  const owner = thread(report, "main").zoneOwners?.[0]?.plugin;
  assert.equal(owner, hostile);
  assert.equal(html(owner ?? ""), "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
});

test("a large v4 capture parses within the limits", async () => {
  const report = JSON.parse(plain("full-v4"), (_key, value, context?: { source: string }) =>
    typeof value === "number" ? BigInt(context?.source ?? "0") : value,
  ) as Raw;
  const main = report.threads[0];
  assert.ok(main);
  const length = 86_400_000_000_000n;
  main.ended_ns = (main.started_ns as bigint) + length;
  (main.network as { coverage: Record<string, bigint> }).coverage.to_ns = length;
  main.resources = {
    samples_dropped: 5000n,
    samples: Array.from({ length: 1200 }, (_, i) => [
      length - BigInt(1199 - i) * 1_000_000_000n,
      1_000_000_000n,
      500_000_000n,
      100_000_000n,
      BigInt(64 + (i % 7)) * MIB,
      128n * MIB,
      BigInt(500 + (i % 9)) * MIB,
      700n * MIB,
    ]),
  };
  main.network = {
    ...(main.network as object),
    transports: [
      {
        name: "raklib",
        counters: Array.from({ length: 64 }, (_, i) => [`raklib_${i}`, BigInt(i)]),
      },
      {
        name: "bedwire",
        counters: Array.from({ length: 64 }, (_, i) => [`bedwire_${i}`, BigInt(i)]),
      },
    ],
  };
  const text = JSON.stringify(report, (_key, value) =>
    typeof value === "bigint" ? rawJSON(String(value)) : value,
  );
  const parsed = await parseReport(buffer(text));
  const resources = parsed.threads[0]?.resources;
  assert.equal(resources?.samples.length, 1200);
  assert.equal(resources?.samplesDropped, 5000n);
  assert.equal(parsed.threads[0]?.network?.transports?.[1]?.counters.length, 64);
  const started = performance.now();
  resourceActivity(resources ?? { samples: [] });
  assert.ok(performance.now() - started < 200);
});

test("empty histories and absent resources produce no phantom values", async () => {
  const report = await load("empty-v4");
  assert.deepEqual(asyncProfile(report).rows, []);
  const empty = await parseReport(
    buffer(
      changed((_r, main) => {
        main.resources = null;
      }),
    ),
  );
  assert.equal(empty.threads[0]?.resources, null);
  await rejects(
    changed((_r, main) => {
      main.resources = { samples: [], samples_dropped: 0n };
    }),
    /history/,
  );
});
