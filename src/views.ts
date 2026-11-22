import {
  asyncProfile,
  formatBytes,
  isMainThread,
  orderedCounters,
  percent,
  pluginProfile,
  resourceActivity,
  signedBytes,
  time,
  TRANSPORT_LABELS,
  type PluginRow,
} from "./analysis.ts";
import type { PulseReport, PulseThread } from "./model/report.ts";
import type { TableConfig } from "./table.ts";
import { cpuPercent, empty, hint, html, metric, panel } from "./ui.ts";

/** lets the viewer re-render a table on sort, search and paging */
export interface TableHost {
  table<R>(config: TableConfig<R>): string;
}

const seconds = (offset: bigint) => `${(Number(offset) / 1e9).toFixed(2)} s`;
const count = (value: bigint) => value.toLocaleString();
const bytesCell = (value: bigint | null) =>
  value === null
    ? '<span class="unavailable" title="Unavailable">—</span>'
    : `<span title="${html(`${value.toLocaleString()} bytes`)}">${html(formatBytes(value))}</span>`;
const signedCell = (value: bigint | null) =>
  value === null
    ? '<span class="unavailable" title="Unavailable">—</span>'
    : `<span class="${value > 0n ? "delta-up" : value < 0n ? "delta-down" : ""}" title="${html(`${value.toLocaleString()} bytes`)}">${html(signedBytes(value))}</span>`;
const na = (reason: string) => `<span class="unavailable" title="${html(reason)}">—</span>`;

function chart(
  id: string,
  label: string,
  unit: string,
  samples: { offsetNs: bigint }[],
  series: {
    name: string;
    pick: (index: number) => number | null;
    dashed?: boolean;
    tone?: string;
  }[],
): string {
  const first = samples[0]?.offsetNs ?? 0n;
  const last = samples.at(-1)?.offsetNs ?? first;
  const span = Number(last - first) || 1;
  let max = 1;
  for (const item of series)
    for (let i = 0; i < samples.length; i++) max = Math.max(max, item.pick(i) ?? 0);
  max *= 1.05;
  const x = (offset: bigint) => 55 + (Number(offset - first) / span) * 910;
  const y = (value: number) => 220 - (value / max) * 190;
  const showAllPoints = samples.length <= 120;
  const paths = series
    .map((item) => {
      let path = "";
      let connected = false;
      const points: string[] = [];
      samples.forEach((sample, index) => {
        const value = item.pick(index);
        if (value === null) {
          connected = false;
          return;
        }
        const px = x(sample.offsetNs).toFixed(2);
        const py = y(value).toFixed(2);
        path += `${connected ? "L" : "M"}${px} ${py} `;
        const isolated =
          !connected && (index + 1 === samples.length || item.pick(index + 1) === null);
        if (showAllPoints || isolated)
          points.push(
            `<circle cx="${px}" cy="${py}" r="2" class="series-point series-${item.tone ?? "main"}"><title>${html(item.name)}: ${value.toFixed(1)} ${unit} at ${seconds(sample.offsetNs)}</title></circle>`,
          );
        connected = true;
      });
      return `<path d="${path}" class="series-line series-${item.tone ?? "main"}${item.dashed ? " series-dashed" : ""}" />${points.join("")}`;
    })
    .join("");
  const grid = Array.from(
    { length: 5 },
    (_, i) =>
      `<line x1="55" x2="965" y1="${220 - i * 47.5}" y2="${220 - i * 47.5}" class="chart-grid" />`,
  ).join("");
  const yLabels = Array.from(
    { length: 5 },
    (_, i) =>
      `<span style="top:${((220 - i * 47.5) / 260) * 100}%">${((max * i) / 4).toFixed(max < 10 ? 1 : 0)}</span>`,
  ).join("");
  const xLabels = Array.from({ length: 5 }, (_, i) => {
    const secondsValue = (Number(first) + (span * i) / 4) / 1e9;
    return `<span style="left:${5.5 + i * 22.75}%" class="${i === 0 ? "axis-first" : i === 4 ? "axis-last" : ""}">${secondsValue >= 3600 ? `${(secondsValue / 3600).toFixed(2)} h` : `${secondsValue.toFixed(1)} s`}</span>`;
  }).join("");
  const legend = series
    .map(
      (item) =>
        `<span class="series-key"><i class="series-swatch series-${item.tone ?? "main"}${item.dashed ? " series-dashed" : ""}"></i>${html(item.name)}</span>`,
    )
    .join("");
  return `<div class="timeline-wrap resource-chart"><div class="timeline-plot"><div class="axis-y" aria-hidden="true"><small>${unit}</small>${yLabels}</div><div class="axis-x" aria-hidden="true">${xLabels}</div><svg id="${id}" viewBox="0 0 1000 260" role="img" aria-label="${html(label)}" preserveAspectRatio="none">${grid}${paths}</svg></div><p class="view-note chart-legend">${legend}</p></div>`;
}

const mib = (value: bigint) => Number(value) / 1_048_576;

function workerHeaps(report: PulseReport, host: TableHost): string {
  const rows = report.threads.flatMap((thread, index) =>
    thread.async && !isMainThread(thread)
      ? [
          {
            name: thread.name,
            index,
            ran: thread.async.ran,
            heap: thread.async.heapBytes,
            peak: thread.async.heapPeakBytes,
          },
        ]
      : [],
  );
  if (rows.length === 0)
    return panel(
      "Worker PHP heaps",
      "Sampled on each worker after its last recorded task.",
      empty(
        report.version < 4
          ? "Worker heap samples require Pulse v4."
          : "No worker threads were captured in this report.",
      ),
    );
  return panel(
    "Worker PHP heaps",
    "Each worker's heap after its last recorded task, and the highest such value. Workers with no recorded tasks show no heap.",
    host.table({
      id: "worker-heaps",
      label: "Worker PHP heaps",
      placeholder: "Search workers…",
      empty: "No workers match this search.",
      defaultSort: "peak",
      rows,
      search: (row) => row.name,
      columns: [
        {
          key: "name",
          label: "Worker",
          text: true,
          value: (row) => row.name,
          cell: (row) => html(row.name),
        },
        { key: "ran", label: "Tasks run", value: (row) => row.ran, cell: (row) => count(row.ran) },
        {
          key: "heap",
          label: "Last heap",
          title: "PHP heap after the worker's last recorded task",
          value: (row) => (row.ran > 0n ? row.heap : null),
          cell: (row) => (row.ran > 0n ? bytesCell(row.heap) : na("No tasks ran on this worker")),
        },
        {
          key: "peak",
          label: "Peak heap",
          title: "Highest heap seen after any recorded task",
          value: (row) => (row.ran > 0n ? row.peak : null),
          cell: (row) => (row.ran > 0n ? bytesCell(row.peak) : na("No tasks ran on this worker")),
        },
      ],
    }),
  );
}

export function memoryView(report: PulseReport, item: PulseThread, host: TableHost): string {
  const explainer = `<details class="reading-notes" open><summary>PHP heap versus process memory</summary><p><b>PHP heap</b> is what PHP's allocator reports for the main thread (<code>memory_get_usage()</code>). <b>Allocated</b> is the capacity PHP has obtained from the system for it. Neither includes worker thread heaps, native library memory or thread stacks.</p><p><b>Process RSS</b> is the resident memory of the whole server process, read from <code>/proc/self/status</code> on Linux. It includes the PHP heap and also workers, native allocations, thread stacks and mapped libraries, so it is normally larger and is not an estimate of native heap use. The <b>process peak</b> is the highest RSS since the process launched, which can predate this capture.</p><p>Memory is sampled at most once per second when a tick finishes, plus a final sample at the end. Short peaks between samples are not visible, and a stalled tick delays the next sample. Growth compares retained samples and is not a leak diagnosis: caches, loaded chunks and garbage collection all move these numbers.</p></details>`;
  if (report.version < 3)
    return `${empty(`Memory telemetry is unavailable in Pulse v${report.version}. Open a v3 or newer capture to inspect PHP heap history. Process RSS needs v4.`)}${explainer}`;
  if (!item.resources) {
    return `${empty("Memory samples are recorded on the main thread only. Select the main thread to inspect PHP heap and process memory.")}${workerHeaps(report, host)}${explainer}`;
  }
  const data = resourceActivity(item.resources);
  const current = data.current;
  if (!current)
    return `${empty("No memory samples were retained on this thread.")}${workerHeaps(report, host)}${explainer}`;
  const hasRss = item.resources.hasRss;
  const rssNote = !hasRss
    ? `Process RSS needs Pulse v4; this capture is v${report.version}.`
    : data.rssAvailableSamples === 0
      ? "Unavailable on this platform. Quark reads RSS from /proc on Linux."
      : data.rssAvailableSamples < data.samples.length
        ? `Available in ${data.rssAvailableSamples.toLocaleString()} of ${data.samples.length.toLocaleString()} samples.`
        : "Latest retained sample";
  const rssValue = (value: bigint | null) => (value === null ? "Unavailable" : formatBytes(value));
  const dropped = item.resources.samplesDropped > 0n;
  const growthNote = dropped
    ? "First to last retained sample; earlier history was dropped."
    : "First to last sample of the capture";
  const metrics = `<div class="metrics resource-metrics">${metric("PHP heap used", formatBytes(current.memoryBytes), "Latest main-thread sample")}${metric("PHP heap allocated", formatBytes(current.memoryAllocatedBytes), "Latest main-thread sample")}${metric("PHP heap change", data.memoryGrowth === null ? "—" : signedBytes(data.memoryGrowth), data.memoryGrowth === null ? "Needs at least two samples" : growthNote, true)}${metric("Process RSS", hasRss ? rssValue(data.rssCurrent) : "—", rssNote)}${metric("RSS change", data.rssGrowth === null ? "—" : signedBytes(data.rssGrowth), data.rssGrowth === null ? (hasRss ? "Needs two samples with RSS" : "Requires Pulse v4") : growthNote)}${metric("Process peak RSS", hasRss ? rssValue(data.rssProcessPeak) : "—", hasRss ? "Highest since process launch (VmHWM)" : "Requires Pulse v4")}</div>`;
  const heapChart = chart(
    "memory-heap-chart",
    "PHP used and allocated heap in MiB over capture time",
    "MiB",
    data.samples,
    [
      { name: "PHP heap used", pick: (i) => mib(data.samples[i]?.memoryBytes ?? 0n) },
      {
        name: "PHP heap allocated",
        pick: (i) => mib(data.samples[i]?.memoryAllocatedBytes ?? 0n),
        dashed: true,
        tone: "muted",
      },
    ],
  );
  const rssChart =
    hasRss && data.rssAvailableSamples > 0
      ? chart(
          "memory-rss-chart",
          "Process resident memory in MiB over capture time",
          "MiB",
          data.samples,
          [
            {
              name: "Process RSS",
              pick: (i) => {
                const value = data.samples[i]?.rssBytes;
                return value == null ? null : mib(value);
              },
              tone: "warm",
            },
            {
              name: "Process peak RSS",
              pick: (i) => {
                const value = data.samples[i]?.rssPeakBytes;
                return value == null ? null : mib(value);
              },
              dashed: true,
              tone: "muted",
            },
          ],
        )
      : empty(
          !hasRss
            ? `Process RSS needs Pulse v4. This capture is v${report.version}.`
            : "No RSS samples were recorded. Quark reads RSS from /proc on Linux, so other platforms report it as unavailable.",
        );
  const table = host.table({
    id: "memory-samples",
    label: "Resource samples",
    placeholder: "Search samples by time…",
    empty: "No samples match this search.",
    defaultSort: "time",
    ascending: true,
    rows: data.samples,
    search: (row) => seconds(row.offsetNs),
    columns: [
      {
        key: "time",
        label: "Time",
        title: "Offset from the start of the capture",
        value: (row) => row.offsetNs,
        cell: (row) => seconds(row.offsetNs),
        text: true,
      },
      {
        key: "cpu",
        label: "CPU",
        title:
          "Process CPU over the interval; 100% is one core. Unavailable for intervals under one second.",
        value: (row) => row.cpu,
        cell: (row) =>
          row.cpu === null ? na("CPU unavailable for this interval") : cpuPercent(row.cpu),
      },
      {
        key: "used",
        label: "PHP used",
        value: (row) => row.memoryBytes,
        cell: (row) => bytesCell(row.memoryBytes),
      },
      {
        key: "usedDelta",
        label: "Δ used",
        title: "Change from the previous retained sample",
        value: (row) => row.memoryDelta,
        cell: (row) => signedCell(row.memoryDelta),
      },
      {
        key: "allocated",
        label: "PHP allocated",
        value: (row) => row.memoryAllocatedBytes,
        cell: (row) => bytesCell(row.memoryAllocatedBytes),
      },
      {
        key: "rss",
        label: "RSS",
        value: (row) => row.rssBytes,
        cell: (row) => bytesCell(row.rssBytes),
      },
      {
        key: "rssDelta",
        label: "Δ RSS",
        title: "Change from the previous sample; blank when either sample lacks RSS",
        value: (row) => row.rssDelta,
        cell: (row) => signedCell(row.rssDelta),
      },
      {
        key: "peak",
        label: "Peak RSS",
        title: "Process peak since launch",
        value: (row) => row.rssPeakBytes,
        cell: (row) => bytesCell(row.rssPeakBytes),
      },
    ],
  });
  return `<section class="resource-section" aria-label="Memory">${metrics}<div class="overview-grid">${panel("PHP heap", "Main-thread PHP heap. Excludes native memory and worker heaps.", heapChart)}${panel("Process RSS", "Resident memory of the whole process, including native memory and workers.", rssChart)}</div>${panel("Samples", `${data.samples.length.toLocaleString()} retained, ${item.resources.samplesDropped.toLocaleString()} dropped. Unavailable values stay blank instead of showing as zero.`, table)}${workerHeaps(report, host)}${explainer}</section>`;
}

function pluginMessage(
  report: PulseReport,
  item: PulseThread,
  status: "legacy" | "no-owners",
): string {
  if (status === "legacy")
    return empty(
      `Plugin attribution requires Pulse v4. This capture is v${report.version}, so zones cannot be tied to the plugin that registered them. Zones with plugin-style names may appear in Hotspots, but their ownership is not recorded.`,
    );
  return empty(
    isMainThread(item)
      ? "No plugin-owned zones were recorded on this thread. Either no plugin callbacks ran during the capture, or none of the measured zones were registered with an owner."
      : "No plugin-owned zones were recorded on this thread. Plugin callbacks run on the main thread, so select it to see plugin timings.",
  );
}

export function pluginView(
  report: PulseReport,
  item: PulseThread,
  host: TableHost,
  selected: string | undefined,
): { html: string; selected: string | undefined } {
  const profile = pluginProfile(item);
  const notes = `<details class="reading-notes"><summary>How plugin time is measured</summary><p><b>Total</b> counts each plugin's outermost callbacks (event handlers, scheduled tasks, commands, enable and disable). Callbacks nested inside the same plugin are not counted twice. Total includes server work and other plugins' handlers that the callback triggers, so totals of different plugins can overlap and may add up to more than the session.</p><p><b>Self</b> excludes every nested measured zone and never overlaps between plugins, so self times can be added together. <b>Calls</b>, <b>average</b> and <b>max</b> describe outermost callbacks. The percentage divides by the thread's capture span, because handlers also run between ticks.</p><p>Ownership comes from the plugin that registered the handler, task or command. Async task completions are not attributed to plugins, because tasks carry no owner. Only instrumented work is measured, so these figures can understate a plugin's real cost.</p></details>`;
  if (profile.status !== "ok")
    return { html: `${pluginMessage(report, item, profile.status)}${notes}`, selected: undefined };
  const span = item.endedNs - item.startedNs;
  const rows = profile.plugins;
  const chosen = rows.find((row) => row.name === selected) ?? rows[0];
  const combinedSelf = rows.reduce((sum, row) => sum + row.selfNs, 0n);
  const top = rows[0];
  const share = (value: bigint) => (span > 0n ? `${percent(value, span).toFixed(2)}%` : "—");
  const shareBar = (value: bigint) =>
    span > 0n
      ? `<div class="share-cell"><span class="share-track"><i style="width:${Math.min(100, percent(value, span))}%"></i></span>${share(value)}</div>`
      : na("The capture span is zero");
  const metrics = `<div class="metrics">${metric("Plugins measured", String(rows.length), "With at least one owned zone", true)}${metric("Top plugin by total", top?.name ?? "—", top ? `${time(top.totalNs)}, ${share(top.totalNs)} of the session` : "")}${metric("Combined plugin self", time(combinedSelf), `${share(combinedSelf)} of the session; self never overlaps`)}${metric("Share of recorded self", `${percent(profile.ownedSelfNs, profile.selfNs).toFixed(1)}%`, "Plugin self time over all self time on this thread")}${metric("Capture span", seconds(span), "Denominator for percentages")}</div>`;
  const ranking = host.table<PluginRow>({
    id: "plugins",
    label: "Plugins ranked by measured time",
    placeholder: "Search plugins…",
    empty: "No plugins match this search.",
    defaultSort: "total",
    rows,
    search: (row) => row.name,
    rowAttributes: (row) => (row.name === chosen?.name ? 'class="selected-row"' : ""),
    columns: [
      {
        key: "name",
        label: "Plugin",
        text: true,
        value: (row) => row.name,
        cell: (row) =>
          `<button class="plugin-link" data-plugin="${html(row.name)}" aria-pressed="${row.name === chosen?.name}" title="${html(row.name)}">${html(row.name)}</button>`,
      },
      {
        key: "total",
        label: "Total",
        title: "Time inside outermost callbacks, including nested work",
        value: (row) => row.totalNs,
        cell: (row) => time(row.totalNs),
      },
      {
        key: "self",
        label: "Self",
        title: "Time excluding all nested measured zones",
        value: (row) => row.selfNs,
        cell: (row) => `<span class="self-cell">${time(row.selfNs)}</span>`,
      },
      {
        key: "calls",
        label: "Calls",
        title: "Outermost callbacks",
        value: (row) => row.calls,
        cell: (row) => count(row.calls),
      },
      {
        key: "average",
        label: "Avg call",
        value: (row) => (row.calls > 0n ? row.totalNs / row.calls : null),
        cell: (row) => (row.calls > 0n ? time(row.totalNs / row.calls) : na("No calls")),
      },
      { key: "max", label: "Max call", value: (row) => row.maxNs, cell: (row) => time(row.maxNs) },
      {
        key: "share",
        label: "% of session",
        title: "Total divided by the capture span",
        value: (row) => row.totalNs,
        cell: (row) => shareBar(row.totalNs),
      },
      {
        key: "selfShare",
        label: "Self % of session",
        value: (row) => row.selfNs,
        cell: (row) => share(row.selfNs),
      },
    ],
  });
  const detail = chosen
    ? panel(
        html(chosen.name),
        `Zones owned by this plugin on ${html(item.name)}. Outermost total counts a zone only where no ancestor belongs to the same plugin.`,
        host.table({
          id: "plugin-zones",
          label: `Zones owned by ${chosen.name}`,
          placeholder: "Search zones…",
          empty: "No zones match this search.",
          defaultSort: "self",
          rows: chosen.zones,
          search: (row) => row.name,
          columns: [
            {
              key: "name",
              label: "Zone",
              text: true,
              value: (row) => row.name,
              cell: (row) =>
                `<button class="plugin-link" data-zone="${html(row.name)}" title="Open in Hotspots">${html(row.name)}</button>`,
            },
            {
              key: "self",
              label: "Self",
              value: (row) => row.selfNs,
              cell: (row) => `<span class="self-cell">${time(row.selfNs)}</span>`,
            },
            {
              key: "total",
              label: "Outermost total",
              title: "Zero means the zone only ran inside other zones of this plugin",
              value: (row) => row.totalNs,
              cell: (row) =>
                row.totalNs === 0n
                  ? '<span class="unavailable" title="Only runs nested inside this plugin\'s other zones">nested</span>'
                  : time(row.totalNs),
            },
            {
              key: "calls",
              label: "All calls",
              title: "Every call of this zone, nested or not",
              value: (row) => row.calls,
              cell: (row) => count(row.calls),
            },
          ],
        }),
      )
    : "";
  return {
    selected: chosen?.name,
    html: `${metrics}${panel("Plugin ranking", "Ranked by total measured main-thread time. Select a plugin to see its zones.", ranking)}${detail}${notes}`,
  };
}

export function asyncView(report: PulseReport, host: TableHost): string {
  if (report.version < 4)
    return empty(
      `Async worker telemetry requires Pulse v4. This capture is v${report.version}, so submissions, queue waits and worker busy time were not recorded.`,
    );
  const profile = asyncProfile(report);
  if (profile.rows.length === 0)
    return empty("No thread in this report recorded async worker data.");
  const totals = profile.totals;
  const avg = (value: bigint | undefined) => (value === undefined ? "—" : time(value));
  const metrics = `<div class="metrics">${metric("Submitted", count(totals.submitted), "Main-pool tasks queued while recording", true)}${metric("Completed", count(totals.completed), totals.submitted > totals.completed ? `${count(totals.submitted - totals.completed)} without a collected result` : "Every submitted task was collected")}${metric("Peak queue depth", count(totals.queuePeak), "Most tasks one worker held after a submission")}${metric("Avg submit to result", avg(totals.avgTurnaroundNs), totals.avgTurnaroundNs === undefined ? "No completed tasks" : "Submission to collection on the main thread")}${metric("Avg main-thread pickup", avg(totals.avgPickupNs), totals.avgPickupNs === undefined ? "No completed tasks" : "Finished to collected; high means the main thread is behind")}</div><div class="metrics">${metric("Tasks run by workers", count(totals.ran), `${totals.workers} ${totals.workers === 1 ? "worker" : "workers"}, ${totals.idleWorkers} with no tasks`)}${metric("Avg worker queue wait", avg(totals.avgWaitNs), totals.avgWaitNs === undefined ? "No tasks ran" : "Submission to the start of onRun()")}${metric("Avg task run time", avg(totals.avgRunNs), totals.avgRunNs === undefined ? "No tasks ran" : "Duration of onRun()")}${metric("Busiest worker", totals.busiest?.busyPercent == null ? "—" : `${totals.busiest.busyPercent.toFixed(1)}%`, totals.busiest ? `${html(totals.busiest.thread)}, run time over capture span` : "No worker ran tasks")}${metric("Worker heap peak", formatBytes(profile.rows.filter((r) => r.role === "worker" && r.async.ran > 0n).reduce<bigint | null>((max, r) => (max === null || r.async.heapPeakBytes > max ? r.async.heapPeakBytes : max), null)), "Highest after any recorded task")}</div>`;
  const findings = profile.findings.length
    ? `<ul class="findings">${profile.findings.map((finding) => `<li class="finding-${finding.level}"><b>${html(finding.title)}</b><span>${html(finding.detail)}</span></li>`).join("")}</ul>`
    : `<p class="finding-none">No bottleneck indicators crossed their thresholds (worker busy at least 80%, results waiting at least 50 ms on average, or tasks waiting longer than they run). Thresholds are heuristics, not guarantees.</p>`;
  const roleLabel = (row: (typeof profile.rows)[number]) =>
    row.role === "main"
      ? row.hasWork
        ? "Main (submits)"
        : "Main (no submissions)"
      : row.hasWork
        ? "Worker"
        : "Worker (no tasks)";
  const mainOnly = (row: (typeof profile.rows)[number], text: string) =>
    row.role === "main" ? text : na("Measured on the main thread");
  const workerOnly = (row: (typeof profile.rows)[number], text: string) =>
    row.role === "worker" ? text : na("Measured on workers");
  const timeOrNone = (value: bigint | undefined, reason: string) =>
    value === undefined ? na(reason) : time(value);
  const table = host.table({
    id: "async",
    label: "Per-thread async comparison",
    placeholder: "Search threads…",
    empty: "No threads match this search.",
    defaultSort: "busy",
    rows: profile.rows,
    search: (row) => `${row.thread} ${roleLabel(row)}`,
    columns: [
      {
        key: "thread",
        label: "Thread",
        text: true,
        value: (row) => row.thread,
        cell: (row) => `${html(row.thread)}<small class="scope-path">${roleLabel(row)}</small>`,
      },
      {
        key: "submitted",
        label: "Submitted",
        value: (row) => (row.role === "main" ? row.async.submitted : null),
        cell: (row) => mainOnly(row, count(row.async.submitted)),
      },
      {
        key: "completed",
        label: "Completed",
        value: (row) => (row.role === "main" ? row.async.completed : null),
        cell: (row) => mainOnly(row, count(row.async.completed)),
      },
      {
        key: "queue",
        label: "Peak queue",
        title: "Most tasks one worker held right after a submission",
        value: (row) => (row.role === "main" ? row.async.queuePeak : null),
        cell: (row) => mainOnly(row, count(row.async.queuePeak)),
      },
      {
        key: "turnaround",
        label: "Avg submit to result",
        value: (row) => (row.role === "main" ? (row.avgTurnaroundNs ?? null) : null),
        cell: (row) => mainOnly(row, timeOrNone(row.avgTurnaroundNs, "No completed tasks")),
      },
      {
        key: "turnaroundMax",
        label: "Max submit to result",
        value: (row) =>
          row.role === "main" && row.async.completed > 0n ? row.async.turnaroundMaxNs : null,
        cell: (row) =>
          mainOnly(
            row,
            row.async.completed > 0n ? time(row.async.turnaroundMaxNs) : na("No completed tasks"),
          ),
      },
      {
        key: "pickup",
        label: "Avg pickup",
        title: "End of onRun() to collection on the main thread",
        value: (row) => (row.role === "main" ? (row.avgPickupNs ?? null) : null),
        cell: (row) => mainOnly(row, timeOrNone(row.avgPickupNs, "No completed tasks")),
      },
      {
        key: "pickupMax",
        label: "Max pickup",
        value: (row) =>
          row.role === "main" && row.async.completed > 0n ? row.async.pickupMaxNs : null,
        cell: (row) =>
          mainOnly(
            row,
            row.async.completed > 0n ? time(row.async.pickupMaxNs) : na("No completed tasks"),
          ),
      },
      {
        key: "ran",
        label: "Tasks run",
        value: (row) => (row.role === "worker" ? row.async.ran : null),
        cell: (row) => workerOnly(row, count(row.async.ran)),
      },
      {
        key: "wait",
        label: "Avg wait",
        title: "Submission to the start of onRun()",
        value: (row) => (row.role === "worker" ? (row.avgWaitNs ?? null) : null),
        cell: (row) => workerOnly(row, timeOrNone(row.avgWaitNs, "No tasks ran")),
      },
      {
        key: "waitMax",
        label: "Max wait",
        value: (row) => (row.role === "worker" && row.async.ran > 0n ? row.async.waitMaxNs : null),
        cell: (row) =>
          workerOnly(row, row.async.ran > 0n ? time(row.async.waitMaxNs) : na("No tasks ran")),
      },
      {
        key: "run",
        label: "Avg run",
        title: "Duration of onRun()",
        value: (row) => (row.role === "worker" ? (row.avgRunNs ?? null) : null),
        cell: (row) => workerOnly(row, timeOrNone(row.avgRunNs, "No tasks ran")),
      },
      {
        key: "runMax",
        label: "Max run",
        value: (row) => (row.role === "worker" && row.async.ran > 0n ? row.async.runMaxNs : null),
        cell: (row) =>
          workerOnly(row, row.async.ran > 0n ? time(row.async.runMaxNs) : na("No tasks ran")),
      },
      {
        key: "busy",
        label: "Busy",
        title: "Total run time divided by this thread's capture span",
        value: (row) => row.busyPercent,
        cell: (row) =>
          row.role !== "worker"
            ? na("Measured on workers")
            : row.busyPercent === null
              ? na("No tasks ran")
              : `<div class="share-cell"><span class="share-track"><i style="width:${Math.min(100, row.busyPercent)}%"></i></span><span class="${row.busyPercent >= 80 ? "over-budget" : ""}">${row.busyPercent.toFixed(1)}%</span></div>`,
      },
      {
        key: "heap",
        label: "Heap",
        title: "PHP heap after the worker's last recorded task",
        value: (row) => (row.role === "worker" && row.async.ran > 0n ? row.async.heapBytes : null),
        cell: (row) =>
          workerOnly(row, row.async.ran > 0n ? bytesCell(row.async.heapBytes) : na("No tasks ran")),
      },
      {
        key: "heapPeak",
        label: "Peak heap",
        value: (row) =>
          row.role === "worker" && row.async.ran > 0n ? row.async.heapPeakBytes : null,
        cell: (row) =>
          workerOnly(
            row,
            row.async.ran > 0n ? bytesCell(row.async.heapPeakBytes) : na("No tasks ran"),
          ),
      },
    ],
  });
  const notes = `<details class="reading-notes"><summary>How async figures are measured</summary><p><b>Submit to result</b> runs from submission to result collection on the main thread. <b>Main-thread pickup</b> runs from the end of <code>onRun()</code> to collection; high values mean the main thread is falling behind. <b>Peak queue</b> is the most tasks one worker held right after a submission, counting queued, running and finished but uncollected tasks.</p><p>Workers report <b>wait</b> (submission to the start of <code>onRun()</code>), <b>run</b> (<code>onRun()</code> duration) and <b>busy</b> (run time over the worker's capture span). Heap is sampled after each recorded task, so a worker with no tasks has none.</p><p>Only tasks submitted to the main async pool while recording are counted. Tasks still running at the end count as submitted but not completed. Results of tasks queued before recording are ignored. Control and report-writing tasks are excluded. Quark tasks cannot be cancelled and a throwing task crashes its worker, so there are no cancelled or failed counters. A dash means the figure does not apply to that thread or had no tasks to measure; it is not a measured zero.</p></details>`;
  return `${metrics}${panel("Potential bottlenecks", "Heuristic indicators from the figures below. They point where to look, not at a cause.", findings)}${panel("Per-thread comparison", "Main-thread submissions and worker execution side by side. Click a column to sort.", table)}${notes}`;
}

export function transportsPanel(report: PulseReport, item: PulseThread): string {
  const notes = `<details class="reading-notes"><summary>How to read transport counters</summary><p>Counters are totals over the capture (the change since recording started), not packet rates. Peak entries are the highest level observed, not a total. They come from statistics each transport already tracks natively, with no packet contents or session identifiers.</p><p>Rejected packets and drops reflect enforced limits and queue pressure. A rejection is not evidence of an attack, and a non-zero pause or stall count does not by itself mean players were affected. Counters this viewer does not recognise are shown as recorded, so newer Quark versions can add metrics.</p></details>`;
  const subtitle = "Native counters for each transport the server polled while recording.";
  if (report.version < 4)
    return `${panel("Transport statistics", subtitle, empty(`Transport counters require Pulse v4. This capture is v${report.version}.`))}${notes}`;
  const transports = item.network?.transports ?? [];
  if (transports.length === 0)
    return `${panel("Transport statistics", subtitle, empty("No transport counters were recorded on this thread. Transport statistics are collected on the main thread while recording."))}${notes}`;
  const groups = [
    ["traffic", "Traffic"],
    ["pressure", "Pressure and drops"],
    ["peak", "Peaks"],
  ] as const;
  const cards = transports
    .map((transport) => {
      const counters = orderedCounters(transport);
      const lookup = new Map(counters.map((counter) => [counter.name, counter.value]));
      const sections = groups
        .map(([group, title]) => {
          const rows = counters.filter((counter) => counter.info.group === group);
          if (rows.length === 0) return "";
          return `<div class="counter-group"><h3>${title}</h3><dl>${rows
            .map((counter) => {
              const value =
                counter.info.kind === "bytes"
                  ? `<span title="${html(`${counter.value.toLocaleString()} bytes`)}">${html(formatBytes(counter.value))}</span>`
                  : counter.value.toLocaleString();
              return `<div class="counter${counter.info.known ? "" : " counter-unknown"}"><dt>${html(counter.info.label)}${hint(counter.info.detail)}${counter.info.known ? "" : '<span class="badge" title="Not documented by this viewer; shown as recorded">unrecognized</span>'}<small>${html(counter.name)}</small></dt><dd>${value}</dd></div>`;
            })
            .join("")}</dl></div>`;
        })
        .join("");
      const received = lookup.get("packets_received");
      const rejected = lookup.get("packets_rejected");
      const derived =
        received !== undefined && rejected !== undefined && received > 0n
          ? `<p class="counter-derived">Rejected packets were ${html(percent(rejected, received).toFixed(2))}% of packets received over the capture. This compares two counters; it is not a rate and does not imply hostile traffic.</p>`
          : "";
      const label = TRANSPORT_LABELS[transport.name];
      return `<section class="panel transport-card" data-transport="${html(transport.name)}"><div class="panel-heading"><div><h2>${html(label)}</h2><p>${transport.counters.length} ${transport.counters.length === 1 ? "counter" : "counters"} reported${transport.counters.every((counter) => counter.name.startsWith("bytes_")) ? "; byte counters only" : ""}</p></div></div>${sections}${derived}</section>`;
    })
    .join("");
  return `<section class="transport-section" aria-label="Transport statistics"><div class="resource-heading"><h2>Transport statistics</h2><p>${subtitle} Totals over the capture, not rates.</p></div><div class="overview-grid transport-grid">${cards}</div>${notes}</section>`;
}
