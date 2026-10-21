import {
  analyze,
  compare,
  elapsed,
  networkActivity,
  percent,
  time,
  treeRows,
  type SortKey,
} from "./analysis.ts";
import type { PulseNetwork, PulseReport, PulseThread, PulseTick } from "./model/report.ts";

const PAGE_SIZE = 75;
const views = ["Overview", "Call tree", "Hotspots", "Spikes", "Network", "Threads"] as const;
type View = (typeof views)[number];
type ActivityBucket = ReturnType<typeof networkActivity>["buckets"][number];
const paths = [
  "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  "M5 3v14h14M5 7h10M5 12h10M15 5v4M15 10v4M19 15v4",
  "M3 18h18M6 14V9M12 14V3M18 14V6",
  "M2 13h5l3-9 4 16 3-7h5",
  "M3 4h6v6H3zM15 14h6v6h-6zM6 10v7h9M18 14V7H9",
  "M3 5h18M3 12h18M3 19h18M7 3v4M17 10v4M10 17v4",
];
function icon(index: number): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[index]}" /></svg>`;
}
function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
function category(name: string): string {
  if (/^(plugin|event)\./i.test(name)) return "Plugins";
  if (/world|chunk|entity/i.test(name)) return "World";
  if (/network|packet|raknet/i.test(name)) return "Network";
  if (/scheduler|task/i.test(name)) return "Scheduler";
  return "Other";
}
function empty(message: string): string {
  return `<div class="empty"><span class="empty-mark">—</span><p>${message}</p></div>`;
}
function metric(label: string, value: string, detail: string, accent = false): string {
  return `<div class="metric${accent ? " accent-metric" : ""}"><span class="metric-label">${label}</span><strong>${html(value)}</strong><span class="metric-detail">${detail}</span></div>`;
}
function panel(title: string, subtitle: string, content: string, action = ""): string {
  return `<section class="panel"><div class="panel-heading"><div><h2>${title}</h2><p>${subtitle}</p></div>${action}</div>${content}</section>`;
}
function tickLabel(tick: PulseTick): string {
  return `Tick #${tick.id}, ${(Number(tick.offsetNs) / 1e9).toFixed(3)} seconds into capture, ${time(tick.durationNs)}`;
}

export function showReport(host: HTMLElement, report: PulseReport, sample: boolean): void {
  const analyses = report.threads.map(analyze);
  let threadIndex = Math.max(
    0,
    report.threads.findIndex((thread) => thread.tickCount > 0n),
  );
  let view: View = "Overview";
  let query = "";
  let filter = "All zones";
  let sort: SortKey = "selfNs";
  let direction = 1;
  let page = 0;
  let selectedTick = -1;
  let tickPinned = false;
  let selectedSpike: bigint | undefined;
  let budgetMs = 50;
  let minimumSpike = 0;
  let flame = false;
  let flameRoot = 0;
  let networkSession: number | null | "all" = "all";
  let networkBucket = -1;
  let networkBuckets: ActivityBucket[] = [];
  let networkFirst = 0n;
  let networkSpan = 1n;
  const collapsed = new Set<number>();
  const thread = () => report.threads[threadIndex];
  const analysis = () => analyses[threadIndex];

  function metadata(): string {
    const meta = report.metadata;
    return `<dl id="metadata" class="metadata"><dt>Quark</dt><dd>${html(meta.quarkVersion)}</dd><dt>PHP</dt><dd>${html(meta.phpVersion)}</dd><dt>Platform</dt><dd>${html(meta.platform)}</dd><dt>CPU threads</dt><dd>${meta.cpuThreads}</dd><dt>Format</dt><dd>v${report.version}</dd></dl><details class="environment"><summary>Plugins & worlds <span>${meta.plugins.length + meta.worlds.length}</span></summary>${meta.plugins.map((plugin) => `<p>${html(plugin.name)} <span>${html(plugin.version)}</span></p>`).join("")}${meta.worlds.map((world) => `<p>${html(world)} <span>world</span></p>`).join("") || "<p>No environment entries</p>"}</details>`;
  }
  function render(): void {
    const focused = document.activeElement;
    const current = thread();
    const counts = [
      "",
      current?.nodes.length ?? 0,
      analysis()?.hotspots.length ?? 0,
      current?.spikes.length ?? 0,
      current?.network?.events.length ?? "",
      report.threads.length,
    ];
    const description =
      view === "Overview"
        ? "Tick timings and recorded work for this thread."
        : view === "Call tree"
          ? "Follow the work from parent scopes to their children."
          : view === "Hotspots"
            ? "Find the zones with the greatest cost on this thread."
            : view === "Spikes"
              ? "Inspect the scopes recorded inside slow ticks."
              : view === "Network"
                ? "Inspect recorded traffic and packet-handling decisions."
                : "Inspect the work recorded on each thread.";
    host.innerHTML = `<aside class="sidebar"><div class="sidebar-label">Analysis${sample ? '<span class="sample-tag">Sample</span>' : ""}</div><nav aria-label="Analysis views">${views.map((name, index) => `<button class="nav-item${view === name ? " active" : ""}" data-view="${name}" ${view === name ? 'aria-current="page"' : ""}>${icon(index)}<span>${name}</span><small>${counts[index]}</small></button>`).join("")}</nav><div class="sidebar-section"><div class="sidebar-label">Capture</div>${metadata()}</div></aside><div class="analysis-content"><div class="page-heading"><div><div class="eyebrow">${sample ? "Sample capture" : "Capture analysis"}</div><h1>${view}</h1><p>${description}</p></div><label class="thread-picker"><span>Thread</span><select id="thread-select" aria-label="Thread" ${report.threads.length === 0 ? "disabled" : ""}>${report.threads.map((item, index) => `<option value="${index}" ${threadIndex === index ? "selected" : ""}>${html(item.name)}</option>`).join("") || "<option>No threads</option>"}</select></label></div>${current ? warnings(current) : ""}<div id="view-content">${!current && view !== "Threads" ? empty("This capture has no threads. Open another report to start exploring.") : view === "Overview" ? overview() : view === "Call tree" || view === "Hotspots" ? zoneView() : view === "Spikes" ? spikeView() : view === "Network" ? networkView() : threadView()}</div></div>`;
    if (view === "Overview") updateTick();
    if (view === "Spikes") updateSpike();
    if (
      focused instanceof HTMLElement &&
      host.contains(focused) === false &&
      focused !== document.body
    ) {
      if (focused.id) host.querySelector<HTMLElement>(`#${CSS.escape(focused.id)}`)?.focus();
      else if (focused.dataset.view)
        host
          .querySelector<HTMLElement>(`.nav-item[data-view="${CSS.escape(focused.dataset.view)}"]`)
          ?.focus();
    }
  }
  function warnings(item: PulseThread): string {
    const messages = [];
    if (item.recording)
      messages.push("Captured while recording: unfinished scopes can have incomplete totals.");
    if (item.droppedScopes) messages.push(`${item.droppedScopes} scopes dropped.`);
    if (item.unbalancedScopes || item.unbalancedTicks)
      messages.push(
        `${item.unbalancedScopes} unbalanced scopes; ${item.unbalancedTicks} unbalanced ticks.`,
      );
    return messages.length ? `<p class="notice">${messages.join(" ")}</p>` : "";
  }
  function overview(): string {
    const item = thread();
    const data = analysis();
    if (!item || !data) return "";
    const average = item.tickCount ? item.tickTotalNs / item.tickCount : undefined;
    const slow = item.ticks.filter((tick) => Number(tick.durationNs) / 1e6 > budgetMs).length;
    const bars = data.hotspots
      .slice(0, 6)
      .map(
        (zone, index) =>
          `<button class="zone-bar" data-zone="${html(zone.name)}"><span class="zone-rank">${String(index + 1).padStart(2, "0")}</span><span class="zone-bar-main"><span class="zone-bar-name">${html(zone.name)}</span><span class="bar-track"><span style="width:${percent(zone.selfNs, data.selfNs)}%"></span></span></span><span class="zone-bar-value">${time(zone.selfNs)}<small>${percent(zone.selfNs, data.selfNs).toFixed(1)}%</small></span></button>`,
      )
      .join("");
    const slowTicks = [...item.spikes]
      .sort((a, b) =>
        a.tick.durationNs > b.tick.durationNs ? -1 : a.tick.durationNs < b.tick.durationNs ? 1 : 0,
      )
      .slice(0, 5);
    const spikeList = slowTicks
      .map(
        (spike) =>
          `<button class="spike-row" data-spike="${spike.tick.id}"><span class="spike-symbol">↗</span><span>Tick <b>#${spike.tick.id}</b><small>+${(Number(spike.tick.offsetNs) / 1e9).toFixed(2)} s into capture</small></span><strong>${time(spike.tick.durationNs)}</strong></button>`,
      )
      .join("");
    return `<div class="metrics">${metric("Capture duration", elapsed(item), item.recording ? "Unfinished snapshot" : "Thread capture span")}${metric("Average tick", time(average), `${item.tickCount.toLocaleString()} ticks in full capture`, true)}${metric("P95 tick", time(data.p95), "95th percentile of history")}${metric("P99 tick", time(data.p99), "99th percentile of history")}${metric("Maximum tick", time(item.tickCount ? item.tickMaxNs : undefined), "Full capture")}</div>${panel("Tick timeline", `${item.ticks.length.toLocaleString()} of ${item.tickCount.toLocaleString()} ticks retained. ${slow} exceed the ${budgetMs} ms target.`, `${timeline(item)}<div class="chart-footer"><span><i class="legend-line"></i> Tick duration <i class="legend-budget"></i> Target</span><label>Target tick time <input id="budget" type="number" min="1" max="60000" step="1" value="${budgetMs}" aria-label="Target tick time in milliseconds" /> ms</label></div><div id="tick-detail" class="tick-detail"></div>`)}<div class="overview-grid">${panel("Self-time hotspots", "Time spent in each zone, excluding its children", bars || empty("No completed scopes on this thread."), '<button class="text-button" data-view="Hotspots">View all ↗</button>')}${panel("Slowest retained spikes", `Recorded above ${time(item.spikeThresholdNs)}. ${item.spikesDropped.toLocaleString()} spikes dropped.`, spikeList || empty(item.spikeThresholdNs === 0n ? "Spike recording was disabled for this capture." : "No retained spikes on this thread."), '<button class="text-button" data-view="Spikes">Inspect ↗</button>')}</div><div class="capture-footnote"><span>${item.nodes.length.toLocaleString()} call paths, ${data.hotspots.length.toLocaleString()} zones, ${report.threads.length} threads</span><details><summary>How timings are calculated</summary><p>Total time includes child scopes and can overlap. Self time excludes children. P95 and P99 show the durations at or below which 95% and 99% of retained ticks fall, using nearest rank. Averages and maxima cover the full capture.</p></details></div>`;
  }
  function timeline(item: PulseThread): string {
    if (!item.ticks.length) return empty("No tick history was recorded on this thread.");
    let max = Math.max(1, budgetMs);
    for (const tick of item.ticks) max = Math.max(max, Number(tick.durationNs) / 1e6);
    max = Math.ceil(max / 25) * 25;
    const first = item.ticks[0]?.offsetNs ?? 0n;
    const last = item.ticks.at(-1)?.offsetNs ?? first;
    const span = Number(last - first) || 1;
    const x = (tick: PulseTick) => 55 + (Number(tick.offsetNs - first) / span) * 910;
    const y = (tick: PulseTick) => 220 - (Number(tick.durationNs) / 1e6 / max) * 190;
    const line = item.ticks
      .map((tick, index) => `${index ? "L" : "M"}${x(tick).toFixed(2)} ${y(tick).toFixed(2)}`)
      .join(" ");
    const grid = Array.from(
      { length: 5 },
      (_, i) =>
        `<line x1="55" x2="965" y1="${220 - i * 47.5}" y2="${220 - i * 47.5}" class="chart-grid" />`,
    ).join("");
    const yLabels = Array.from(
      { length: 5 },
      (_, i) => `<span style="top:${((220 - i * 47.5) / 260) * 100}%">${(max * i) / 4}</span>`,
    ).join("");
    const xLabels = Array.from({ length: 5 }, (_, i) => {
      const seconds = (Number(first) + (span * i) / 4) / 1e9;
      return `<span style="left:${5.5 + i * 22.75}%" class="${i === 0 ? "axis-first" : i === 4 ? "axis-last" : ""}">${seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${seconds.toFixed(2)} s`}</span>`;
    }).join("");
    const budget = 220 - (budgetMs / max) * 190;
    return `<div class="timeline-wrap"><p id="timeline-help" class="chart-help">Higher peaks mean slower ticks. Click a point to pin it.</p><div class="timeline-plot"><div class="axis-y" aria-hidden="true"><small>ms</small>${yLabels}</div><div class="axis-x" aria-hidden="true">${xLabels}</div><svg id="timeline" viewBox="0 0 1000 260" role="img" aria-label="Tick duration in milliseconds over capture time. Click a point to pin it, or use the tick slider below." data-first="${first}" data-span="${span}" data-max="${max}" preserveAspectRatio="none">${grid}<path d="${line} L${x(item.ticks.at(-1) as PulseTick)} 220 L55 220 Z" class="chart-area" /><line x1="55" x2="965" y1="${budget}" y2="${budget}" class="budget-line" /><path d="${line}" class="chart-line" />${item.ticks
      .filter((tick) => Number(tick.durationNs) / 1e6 > budgetMs)
      .slice(0, 128)
      .map(
        (tick) =>
          `<circle cx="${x(tick)}" cy="${y(tick)}" r="3" class="slow-point" data-tick="${tick.id}" />`,
      )
      .join(
        "",
      )}<line id="tick-marker" x1="0" x2="0" y1="30" y2="220" class="marker-line" /><circle id="tick-point" r="4" class="marker-point" /></svg></div><div class="tick-scrubber"><label for="tick-slider">Select a tick</label><input id="tick-slider" class="tick-slider" type="range" aria-describedby="timeline-help" min="0" max="${item.ticks.length - 1}" value="${selectedTick < 0 ? item.ticks.length - 1 : selectedTick}" /></div></div>`;
  }
  function updateTick(): void {
    const item = thread();
    if (!item) return;
    if (selectedTick < 0 || selectedTick >= item.ticks.length) selectedTick = item.ticks.length - 1;
    const tick = item.ticks[selectedTick];
    const detail = host.querySelector<HTMLElement>("#tick-detail");
    if (!detail || !tick) return;
    const chart = host.querySelector<SVGElement>("#timeline");
    const x =
      55 +
      (Number(tick.offsetNs - BigInt(chart?.dataset.first ?? "0")) /
        Number(chart?.dataset.span ?? "1")) *
        910;
    const y = 220 - (Number(tick.durationNs) / 1e6 / Number(chart?.dataset.max ?? "1")) * 190;
    const marker = host.querySelector("#tick-marker");
    marker?.setAttribute("x1", String(x));
    marker?.setAttribute("x2", String(x));
    const point = host.querySelector("#tick-point");
    point?.setAttribute("cx", String(x));
    point?.setAttribute("cy", String(y));
    const slider = host.querySelector<HTMLInputElement>("#tick-slider");
    if (slider) {
      slider.value = String(selectedTick);
      slider.setAttribute("aria-valuetext", tickLabel(tick));
    }
    detail.innerHTML = `<span class="selected-tick">${tickPinned ? "Pinned tick" : "Tick"} <b>#${tick.id}</b></span><strong>${time(tick.durationNs)}</strong><span>${(Number(tick.offsetNs) / 1e9).toFixed(3)} s into capture</span><span class="${Number(tick.durationNs) / 1e6 > budgetMs ? "over-budget" : "within-budget"}">${Number(tick.durationNs) / 1e6 > budgetMs ? "Above target" : "Within target"}</span><div class="tick-actions"><button class="quiet" data-unpin ${tickPinned ? "" : "hidden"}>Resume hover</button><button class="quiet" data-step="-1" aria-label="Previous tick" ${selectedTick === 0 ? "disabled" : ""}>←</button><button class="quiet" data-step="1" aria-label="Next tick" ${selectedTick === item.ticks.length - 1 ? "disabled" : ""}>→</button>${analysis()?.spikes.has(tick.id) ? `<button class="text-button" data-spike="${tick.id}">Inspect spike ↗</button>` : "<span class='muted'>No spike details</span>"}</div>`;
  }
  function zoneView(): string {
    return `<section class="panel"><div class="table-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input id="zone-search" type="search" placeholder="Search zones…" aria-label="Search zones" value="${html(query)}" /><kbd>/</kbd></label>${view === "Hotspots" ? `<select id="zone-filter" aria-label="Zone category">${["All zones", "Plugins", "World", "Network", "Scheduler", "Other"].map((item) => `<option ${filter === item ? "selected" : ""}>${item}</option>`).join("")}</select>` : `<button class="quiet" data-flame>${flame ? "Table view" : "Flame view"}</button><button class="quiet" data-expand>Expand all</button><button class="quiet" data-collapse>Collapse all</button>`}</div><div id="zone-results">${zoneResults()}</div></section><p class="view-note">${view === "Hotspots" ? "Zones are combined across call paths on this thread. Recursive inclusive totals overlap; self time is additive." : "Each row is a call path. Self time comes directly from Quark; it is not inferred by subtracting children."} Per-zone percentiles are not recorded by this format.</p>`;
  }
  function header(label: string, key?: SortKey): string {
    return `<th ${key ? `aria-sort="${sort === key ? (direction === 1 ? "descending" : "ascending") : "none"}"` : ""}>${key ? `<button data-sort="${key}">${label}${sort === key ? (direction === 1 ? " ↓" : " ↑") : ""}</button>` : label}</th>`;
  }
  function pagination(total: number): string {
    page = Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
    return `<div class="pagination"><span>${total ? (page * PAGE_SIZE + 1).toLocaleString() : 0}–${Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()} rows</span><div><button class="quiet" data-page="-1" ${page === 0 ? "disabled" : ""}>Previous</button><button class="quiet" data-page="1" ${(page + 1) * PAGE_SIZE >= total ? "disabled" : ""}>Next</button></div></div>`;
  }
  function zoneResults(): string {
    const item = thread();
    const data = analysis();
    if (!item || !data) return "";
    if (view === "Call tree" && flame) return flameGraph(item);
    const rows =
      view === "Call tree"
        ? treeRows(item, data, collapsed, sort, query.toLowerCase(), direction).map(
            ({ node, depth }) => ({ ...node, name: item.zones[node.zone] ?? "", depth }),
          )
        : data.hotspots
            .filter(
              (zone) =>
                zone.name.toLowerCase().includes(query.toLowerCase()) &&
                (filter === "All zones" || category(zone.name) === filter),
            )
            .sort((a, b) => compare(a, b, sort) * direction)
            .map((zone) => ({ ...zone, id: 0, depth: 0 }));
    const pages = pagination(rows.length);
    const baseline = view === "Call tree" ? data.rootNs : data.selfNs;
    const body = rows
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map((row) => {
        const share = percent(view === "Call tree" ? row.totalNs : row.selfNs, baseline);
        const childCount = data.children[row.id]?.length ?? 0;
        const closed = !query && collapsed.has(row.id);
        return `<tr><td class="zone-name"><div style="padding-left:${Math.min(row.depth, 16) * 16}px">${view === "Call tree" ? (childCount ? `<button class="tree-toggle" data-node="${row.id}" aria-label="${closed ? "Expand" : "Collapse"} ${html(row.name)}" aria-expanded="${!closed}" ${query ? "disabled" : ""}>${closed ? "▸" : "▾"}</button>` : '<span class="tree-leaf" aria-hidden="true"></span>') : ""}<span title="${html(row.name)}${row.depth ? `, depth ${row.depth}` : ""}">${html(row.name)}</span></div></td><td>${time(row.totalNs)}</td><td class="self-cell">${time(row.selfNs)}</td><td>${time(row.calls ? row.totalNs / row.calls : undefined)}</td><td>${row.calls.toLocaleString()}</td><td>${time(row.maxNs)}</td><td><div class="share-cell"><span class="share-track"><i style="width:${Math.min(100, share)}%"></i></span>${baseline ? `${share.toFixed(1)}%` : "—"}</div></td></tr>`;
      })
      .join("");
    return `<div class="table-scroll"><table><thead><tr>${header(view === "Call tree" ? "Call path" : "Zone")}${header("Total", "totalNs")}${header("Self", "selfNs")}${header("Avg call", "average")}${header("Calls", "calls")}${header("Max call", "maxNs")}${header(view === "Call tree" ? "% root time" : "% self time")}</tr></thead><tbody>${body}</tbody></table></div>${rows.length ? "" : empty("No zones match this search.")}${pages}`;
  }
  function flameGraph(item: PulseThread): string {
    const data = analysis();
    if (!data) return "";
    const root = item.nodes[flameRoot - 1];
    const total = root?.totalNs ?? data.rootNs;
    if (!total) return empty("No completed inclusive time is available for this flame view.");
    const queue = [{ id: flameRoot, x: 0, width: 1000, depth: -1 }];
    const rectangles: string[] = [];
    let maxDepth = 0;
    let incomplete = false;
    while (queue.length && rectangles.length < 1000) {
      const parent = queue.pop();
      if (!parent) break;
      const children = parent.depth === -1 && root ? [root] : (data.children[parent.id] ?? []);
      const denominator = parent.depth === -1 ? total : (item.nodes[parent.id - 1]?.totalNs ?? 0n);
      if (children.reduce((sum, node) => sum + node.totalNs, 0n) > denominator) {
        incomplete = true;
        break;
      }
      let x = parent.x;
      for (const child of children) {
        const width = (percent(child.totalNs, denominator) / 100) * parent.width;
        const depth = parent.depth + 1;
        if (width >= 1 && depth < 16 && rectangles.length < 1000) {
          const name = item.zones[child.zone] ?? "";
          const match = query && name.toLowerCase().includes(query.toLowerCase());
          rectangles.push(
            `<g data-flame-node="${child.id}" tabindex="0" role="button" aria-label="Zoom into ${html(name)}, total ${time(child.totalNs)}, self ${time(child.selfNs)}"><title>${html(name)}\nTotal ${time(child.totalNs)}, Self ${time(child.selfNs)}, ${child.calls} calls</title><rect x="${x}" y="${depth * 34}" width="${Math.max(0, width - 1)}" height="32" class="flame-cell${match ? " flame-match" : ""}" style="--flame-color:${["#365d54", "#3d586c", "#625845", "#565177"][depth % 4]}" />${width > 32 ? `<text x="${x + 7}" y="${depth * 34 + 21}">${html(name.slice(0, Math.max(1, Math.floor((width - 14) / 7))))}</text>` : ""}</g>`,
          );
          queue.push({ id: child.id, x, width, depth });
          maxDepth = Math.max(maxDepth, depth);
        }
        x += width;
      }
    }
    if (incomplete)
      return empty(
        "Incomplete parent totals cannot define a flame graph. Use the table to inspect this capture.",
      );
    return `<div class="flame-heading"><span>${root ? html(item.zones[root.zone] ?? "") : "All root scopes"}, ${time(total)}</span><button class="quiet" data-flame-reset ${flameRoot ? "" : "disabled"}>Reset zoom</button></div><div class="flame-scroll"><svg class="flame-graph" viewBox="0 0 1000 ${(maxDepth + 1) * 34}" aria-label="Aggregate inclusive call paths">${rectangles.join("")}</svg></div><p class="view-note">Widths show aggregate inclusive time, not execution order. Click a scope to zoom. At most 1,000 scopes and 16 levels are shown; widths below 0.1% are omitted.</p>`;
  }
  function spikeView(): string {
    const item = thread();
    if (!item) return "";
    const spikes = item.spikes.filter(
      (spike) => Number(spike.tick.durationNs) / 1e6 >= minimumSpike,
    );
    if (!spikes.some((spike) => spike.tick.id === selectedSpike))
      selectedSpike = spikes[0]?.tick.id;
    return `<div class="spike-summary"><span><strong>${item.spikes.length}</strong> retained spikes</span><span>Capture threshold <b>${time(item.spikeThresholdNs)}</b></span><span><b>${item.spikesDropped.toLocaleString()}</b> spikes dropped</span><label>Minimum <input id="minimum-spike" type="number" value="${minimumSpike}" min="0" max="60000" aria-label="Minimum spike duration in milliseconds" /> ms</label></div><div class="spike-layout"><section class="panel spike-list" aria-label="Retained spikes">${spikes.map((spike) => `<button class="spike-row${selectedSpike === spike.tick.id ? " selected" : ""}" data-select-spike="${spike.tick.id}" aria-pressed="${selectedSpike === spike.tick.id}"><span>Tick <b>#${spike.tick.id}</b><small>+${(Number(spike.tick.offsetNs) / 1e9).toFixed(3)} s</small></span><strong>${time(spike.tick.durationNs)}</strong></button>`).join("") || empty(item.spikeThresholdNs ? "No retained spikes match this filter." : "Spike recording was disabled.")}</section><section id="spike-detail" class="panel"></section></div><p class="view-note">Only scopes retained by Quark are available. A spike may predate the retained tick history; missing neighbors cannot be reconstructed.</p>`;
  }
  function updateSpike(): void {
    const item = thread();
    const spike = analysis()?.spikes.get(selectedSpike ?? -1n);
    const detail = host.querySelector<HTMLElement>("#spike-detail");
    if (!item || !detail) return;
    if (!spike) {
      detail.innerHTML = empty("Select a retained spike to inspect its scopes.");
      return;
    }
    const neighbors = item.ticks.filter(
      (tick) => tick.id >= spike.tick.id - 2n && tick.id <= spike.tick.id + 2n,
    );
    const rows = [...spike.nodes].sort((a, b) =>
      a.selfNs > b.selfNs ? -1 : a.selfNs < b.selfNs ? 1 : a.id - b.id,
    );
    const total = rows.reduce((sum, node) => sum + node.selfNs, 0n);
    const pages = pagination(rows.length);
    detail.innerHTML = `<div class="panel-heading"><div><div class="eyebrow">Retained spike</div><h2>Tick #${spike.tick.id}</h2><p>+${(Number(spike.tick.offsetNs) / 1e9).toFixed(3)} s into this thread's capture</p></div><strong class="spike-duration">${time(spike.tick.durationNs)}</strong></div><div class="neighbors"><span>Nearby ticks</span>${neighbors.map((tick) => `<button class="quiet${tick.id === spike.tick.id ? " current" : ""}" data-history-tick="${tick.id}"><b>#${tick.id}</b> ${time(tick.durationNs)}</button>`).join("") || '<span class="muted">Outside retained history</span>'}</div><div class="table-scroll"><table><thead><tr><th>Call path</th><th>Total</th><th>Self</th><th>Calls</th><th>% self</th></tr></thead><tbody>${rows
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map((row) => {
        const node = item.nodes[row.id - 1];
        const name = item.zones[node?.zone ?? -1] ?? "";
        const ancestors: string[] = [];
        let parent = node?.parent ?? 0;
        while (parent && ancestors.length < 16) {
          const ancestor = item.nodes[parent - 1];
          if (!ancestor) break;
          ancestors.push(item.zones[ancestor.zone] ?? "");
          parent = ancestor.parent;
        }
        return `<tr><td class="zone-name" title="${html([...ancestors.reverse(), name].join(" → "))}">${html(name)}<small class="scope-path">Path #${row.id}${node?.parent ? `, parent #${node.parent}` : ", root"}</small></td><td>${time(row.totalNs)}</td><td class="self-cell">${time(row.selfNs)}</td><td>${row.calls.toLocaleString()}</td><td>${percent(row.selfNs, total).toFixed(1)}%</td></tr>`;
      })
      .join(
        "",
      )}</tbody></table></div>${rows.length ? "" : empty("No scope detail was retained for this tick.")}${pages}`;
  }
  function threadView(): string {
    if (!report.threads.length) return empty("No threads were captured in this report.");
    return panel(
      "Thread captures",
      "Each row has its own capture span and counters. Thread times can overlap.",
      `<div class="table-scroll"><table class="thread-table"><thead><tr><th>Thread</th><th>Duration</th><th>Recorded self time</th><th>Ticks</th><th>Avg tick</th><th>Spikes</th><th></th></tr></thead><tbody>${report.threads.map((item, index) => `<tr><td>${html(item.name)}<small class="scope-path">${item.recording ? "Unfinished snapshot" : "Stopped capture"}, ${item.nodes.length} paths</small></td><td>${elapsed(item)}</td><td>${time(analyses[index]?.selfNs ?? 0n)}</td><td>${item.tickCount.toLocaleString()}</td><td>${time(item.tickCount ? item.tickTotalNs / item.tickCount : undefined)}</td><td>${item.spikes.length}</td><td><button class="text-button" data-thread="${index}">Inspect ↗</button></td></tr>`).join("")}</tbody></table></div>`,
    );
  }
  function bucketDetail(data: PulseNetwork, bucket: ActivityBucket): string {
    const seconds = (value: bigint) => `${(Number(value) / 1e9).toFixed(3)} s`;
    const count = (value: bigint) =>
      `${data.counterOverflows ? "≥ " : ""}${value.toLocaleString()}`;
    return `<span>Bucket <b>${seconds(bucket.offsetNs)}</b>${bucket.offsetNs + data.windowNs > data.toNs ? " (partial)" : ""}${data.windowsDropped > 0n && bucket.offsetNs === data.windows[0]?.offsetNs ? " (may be incomplete)" : ""}</span><strong>${count(bucket.packets)} packets</strong><span>${count(bucket.receivedBytes)} received bytes</span><span>${count(bucket.decodeFailed)} decoding failures</span>`;
  }
  function selectNetworkBucket(index: number): void {
    const data = thread()?.network;
    const selected = networkBuckets[index];
    if (!data || !selected) return;
    networkBucket = index;
    const slider = host.querySelector<HTMLInputElement>("#network-bucket");
    if (slider) {
      slider.value = String(index);
      slider.setAttribute(
        "aria-valuetext",
        `${(Number(selected.offsetNs) / 1e9).toFixed(3)} s, ${selected.packets.toLocaleString()} packets`,
      );
    }
    const marker = 55 + (Number(selected.offsetNs - networkFirst) / Number(networkSpan)) * 910;
    host.querySelector(".traffic-selected")?.setAttribute("d", `M${marker} 22V200`);
    const detail = host.querySelector<HTMLElement>("#network-bucket-detail");
    if (detail) detail.innerHTML = bucketDetail(data, selected);
  }
  function networkView(): string {
    const item = thread();
    const data = item?.network;
    if (!data)
      return empty(
        "Network telemetry is unavailable in Pulse v1. Record a Pulse v2 capture with Quark to inspect packet activity.",
      );
    const activity = networkActivity(data, networkSession);
    const { totals, buckets, events } = activity;
    networkBucket = Math.max(
      0,
      Math.min(networkBucket < 0 ? buckets.length - 1 : networkBucket, buckets.length - 1),
    );
    const selected = buckets[networkBucket];
    const session = data.sessions.find((session) => session.id === networkSession);
    const count = (value: bigint) =>
      `${data.counterOverflows ? "≥ " : ""}${value.toLocaleString()}`;
    const seconds = (value: bigint) => `${(Number(value) / 1e9).toFixed(3)} s`;
    const labels: Record<string, string> = {
      "rate.batch": "Batch rate limit",
      "rate.packet": "Packet rate limit",
      "batch.packet_limit": "Batch packet limit",
      "batch.empty": "Empty batch",
      "batch.malformed": "Malformed batch",
      "packet.unknown": "Unknown packet",
      "packet.direction": "Invalid packet direction",
      "packet.state": "Invalid packet state",
      "packet.malformed": "Malformed packet",
      "packet.handler_validation": "Handler validation failure",
      "compression.algorithm": "Invalid compression algorithm",
      "decompression.malformed": "Malformed compressed data",
      "decompression.limit": "Decompression size limit",
      "encryption.invalid": "Invalid encryption",
      "packet.bad_packet_disconnect": "Bad packet disconnect",
      "transport.header": "Invalid transport header",
    };
    const options = `<option value="all">All recorded sessions</option>${data.sessions.map((session) => `<option value="${session.id}" ${networkSession === session.id ? "selected" : ""}>Session ${session.id}</option>`).join("")}<option value="unknown" ${networkSession === null ? "selected" : ""}>Unattributed activity</option>`;
    const maximum = buckets.reduce(
      (max, bucket) => (bucket.packets > max ? bucket.packets : max),
      1n,
    );
    const first = buckets[0]?.offsetNs ?? 0n;
    const lastEnd = (buckets.at(-1)?.offsetNs ?? first) + data.windowNs;
    const chartEnd = lastEnd < data.toNs ? lastEnd : data.toNs;
    const span = chartEnd > first ? chartEnd - first : data.windowNs;
    networkBuckets = buckets;
    networkFirst = first;
    networkSpan = span;
    const bars: string[] = [];
    const stride = Math.max(1, Math.ceil(buckets.length / 240));
    for (let i = 0; i < buckets.length; i += stride) {
      let peak = i;
      for (let j = i + 1; j < Math.min(buckets.length, i + stride); j++)
        if ((buckets[j]?.packets ?? 0n) > (buckets[peak]?.packets ?? 0n)) peak = j;
      const bucket = buckets[peak];
      if (!bucket) continue;
      const x = 55 + (Number(bucket.offsetNs - first) / Number(span)) * 910;
      const height =
        bucket.packets === 0n ? 0 : Math.max(1, percent(bucket.packets, maximum) * 1.8);
      const width = Math.max(2, Math.min(30, 910 / Math.max(1, buckets.length / stride) - 2));
      bars.push(
        `<rect data-network-bucket="${peak}" x="${x}" y="${200 - height}" width="${Math.max(0, Math.min(width, 965 - x))}" height="${height}" class="traffic-bar" />`,
      );
    }
    const marker = selected ? 55 + (Number(selected.offsetNs - first) / Number(span)) * 910 : 55;
    const chart = selected
      ? `<div class="network-chart"><svg viewBox="0 0 1000 230" aria-label="Packets in retained one-second buckets"><text x="55" y="15">${maximum.toLocaleString()} packets</text><path d="M55 200H965" class="traffic-axis" />${bars.join("")}<path d="M${marker} 22V200" class="traffic-selected" /><text x="55" y="225">${seconds(first)}</text><text x="965" y="225" text-anchor="end">${seconds(chartEnd)}</text></svg></div><div class="network-bucket-controls"><label for="network-bucket">Select activity bucket</label><input id="network-bucket" type="range" min="0" max="${buckets.length - 1}" value="${networkBucket}" aria-valuetext="${seconds(selected.offsetNs)}, ${selected.packets.toLocaleString()} packets" /></div><div id="network-bucket-detail" class="tick-detail">${bucketDetail(data, selected)}</div>`
      : empty("No activity windows were retained for this selection.");
    const outcome = (
      [
        ["Decoded", totals.decoded],
        ["Decode failed", totals.decodeFailed],
        ["Plugin cancelled", totals.pluginCancelled],
        ["State discarded", totals.stateDropped],
        ["Repeated discarded", totals.repeatedDropped],
      ] as const
    )
      .map(
        ([label, value]) =>
          `<div class="network-outcome"><span>${label}</span><span class="bar-track"><span style="width:${percent(value, totals.packets)}%"></span></span><strong>${count(value)}</strong></div>`,
      )
      .join("");
    page = Math.max(0, Math.min(page, Math.ceil(events.length / PAGE_SIZE) - 1));
    const eventRows = events
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map(
        (event) =>
          `<tr><td title="${event.offsetNs} ns">${seconds(event.offsetNs)}<small class="scope-path">${event.tickId === null ? "Tick unavailable" : `Tick #${event.tickId}`}</small></td><td>${event.sessionId === null ? "Unattributed" : `Session ${event.sessionId}`}</td><td>${event.packetId === null ? "Unknown" : event.packetId}</td><td>${labels[event.reason]}<small class="scope-path">${event.reason}</small></td><td>${event.action.replaceAll("_", " ")}</td><td>${event.phase.replaceAll("_", " ")}</td><td>${event.observed === null ? "Unknown" : event.observed.toLocaleString()}</td><td>${event.limit === null ? "Unknown" : event.limit.toLocaleString()}</td></tr>`,
      )
      .join("");
    const losses =
      data.sessionsDropped || data.eventsDropped || data.windowsDropped || data.counterOverflows;
    return `<div class="network-toolbar"><label for="network-session">Session</label><select id="network-session">${options}</select><span>${session ? `Protocol ${session.protocol ?? "unknown"}, ${session.phase.replaceAll("_", " ")}. First observed ${seconds(session.firstNs)}${session.closedNs === null ? "" : `, closed ${seconds(session.closedNs)}`}` : "Session IDs are local to this thread and capture."}</span></div>${losses ? '<p class="notice">Telemetry is incomplete. Retained totals may understate activity. See coverage details below.</p>' : ""}<div class="metrics">${metric("Recorded packets", count(totals.packets), "Retained windows", true)}${metric("Received bytes", count(totals.receivedBytes), "MCPE batches, before decryption")}${metric("Decompressed bytes", count(totals.decompressedBytes), "Retained window total")}${metric("Decoding failures", count(totals.decodeFailed), "Separate from plugin cancellations")}${metric("Recorded events", events.length.toLocaleString(), "Event records, not attack count")}</div>${panel("Packet activity", stride > 1 ? "Each bar shows the busiest retained bucket in that part of the timeline. Select a bucket for exact counts." : "Each bar shows packets in a retained one-second bucket. Click a bar or use the slider to inspect it.", chart)}<div class="overview-grid">${panel("Packet outcomes", "Counts overlap. A decoded packet may be cancelled or discarded later.", `<div class="network-outcomes">${outcome}</div>`)}${panel("Capture coverage", `${seconds(data.fromNs)} to ${seconds(data.toNs)} on this thread`, `<dl class="network-coverage"><dt>Retained sessions</dt><dd>${data.sessions.length}</dd><dt>Sessions not retained</dt><dd>${data.sessionsDropped.toLocaleString()}</dd><dt>Events evicted</dt><dd>${data.eventsDropped.toLocaleString()}</dd><dt>Windows evicted</dt><dd>${data.windowsDropped.toLocaleString()}</dd><dt>Counter saturations</dt><dd>${data.counterOverflows.toLocaleString()}</dd></dl>`)}</div>${panel("Recorded decisions", "Events show validation failures and enforced limits. They do not establish malicious intent.", `<div class="table-scroll"><table id="network-events" class="network-events"><thead><tr><th>Time</th><th>Session</th><th>Packet ID</th><th>Reason</th><th>Action</th><th>Phase</th><th>Observed</th><th>Limit or expected</th></tr></thead><tbody>${eventRows}</tbody></table></div>${events.length ? pagination(events.length) : empty("No decision events were retained for this selection.")}`)}<details class="network-notes"><summary>How to read this evidence</summary><p>One failure can produce a rejection and a separate disconnect event. Event records are not distinct attacks. Rate-limit observations compare requested tokens with available token budget. Decompression-limit observations may be a measured decoded prefix or a declared output length, rather than the full payload size.</p><p>Traffic bytes exclude RakNet framing. Unknown session IDs may combine activity from unretained sessions. Missing buckets are not reconstructed; evictions may leave the earliest retained bucket incomplete. Counter saturation makes displayed window totals lower bounds. The final bucket may cover less than one second. Recording gaps prevent conclusions about unrecorded traffic.</p></details>`;
  }
  function resetThread(index: number): void {
    if (!report.threads[index]) return;
    threadIndex = index;
    page = 0;
    selectedTick = -1;
    tickPinned = false;
    selectedSpike = undefined;
    collapsed.clear();
    flameRoot = 0;
    networkSession = "all";
    networkBucket = -1;
    render();
  }
  function updateZones(): void {
    const results = host.querySelector("#zone-results");
    if (results) results.innerHTML = zoneResults();
  }
  host.onclick = (event) => {
    const chart =
      event.target instanceof Element ? event.target.closest<SVGElement>("#timeline") : null;
    if (chart) {
      const index = tickAt(chart, event.clientX, event.target);
      if (index < 0) return;
      selectedTick = index;
      tickPinned = true;
      updateTick();
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("button,[data-flame-node],[data-network-bucket]")
        : null;
    if (!target || target.matches(":disabled")) return;
    const action = target.dataset;
    if (action.view && views.includes(action.view as View)) {
      view = action.view as View;
      page = 0;
      render();
    } else if (action.networkBucket !== undefined) {
      selectNetworkBucket(Number(action.networkBucket));
    } else if (action.thread) {
      view = "Overview";
      resetThread(Number(action.thread));
    } else if (action.zone !== undefined) {
      query = action.zone;
      filter = "All zones";
      view = "Hotspots";
      page = 0;
      render();
    } else if (action.spike) {
      selectedSpike = BigInt(action.spike);
      minimumSpike = 0;
      view = "Spikes";
      page = 0;
      render();
    } else if (action.selectSpike) {
      selectedSpike = BigInt(action.selectSpike);
      page = 0;
      for (const row of host.querySelectorAll<HTMLElement>(".spike-row")) {
        const selected = row.dataset.selectSpike === action.selectSpike;
        row.classList.toggle("selected", selected);
        row.setAttribute("aria-pressed", String(selected));
      }
      updateSpike();
    } else if (action.historyTick) {
      view = "Overview";
      tickPinned = true;
      selectedTick =
        thread()?.ticks.findIndex((tick) => tick.id === BigInt(action.historyTick ?? "0")) ?? -1;
      render();
    } else if (action.step) {
      tickPinned = true;
      selectedTick += Number(action.step);
      updateTick();
    } else if (action.unpin !== undefined) {
      tickPinned = false;
      updateTick();
      host.querySelector<HTMLInputElement>("#tick-slider")?.focus({ preventScroll: true });
    } else if (action.sort) {
      direction = sort === action.sort ? -direction : 1;
      sort = action.sort as SortKey;
      page = 0;
      updateZones();
    } else if (action.node) {
      const id = Number(action.node);
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      updateZones();
    } else if (action.page) {
      page += Number(action.page);
      if (view === "Spikes") updateSpike();
      else if (view === "Network") render();
      else updateZones();
    } else if (action.expand !== undefined) {
      collapsed.clear();
      page = 0;
      updateZones();
    } else if (action.collapse !== undefined) {
      for (const node of thread()?.nodes ?? []) collapsed.add(node.id);
      page = 0;
      updateZones();
    } else if (action.flame !== undefined) {
      flame = !flame;
      render();
    } else if (action.flameNode) {
      flameRoot = Number(action.flameNode);
      updateZones();
    } else if (action.flameReset !== undefined) {
      flameRoot = 0;
      updateZones();
    }
    if (document.activeElement === document.body) {
      const [key, value] = Object.entries(action)[0] ?? [];
      const attribute = key?.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const replacement =
        attribute && value !== undefined
          ? host.querySelector<HTMLElement>(
              `[data-${attribute}="${CSS.escape(value)}"]:not(:disabled)`,
            )
          : null;
      const focus = replacement ?? host.querySelector<HTMLElement>(".page-heading h1");
      if (focus) {
        if (!replacement) focus.tabIndex = -1;
        focus.focus({ preventScroll: true });
      }
    }
  };
  host.oninput = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === "zone-search") {
      query = target.value;
      page = 0;
      updateZones();
    } else if (target.id === "tick-slider") {
      tickPinned = true;
      selectedTick = Number(target.value);
      updateTick();
    } else if (target.id === "network-bucket") {
      selectNetworkBucket(Number(target.value));
    }
  };
  host.onchange = (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      if (target.id === "thread-select") resetThread(Number(target.value));
      else if (target.id === "network-session") {
        networkSession =
          target.value === "all" ? "all" : target.value === "unknown" ? null : Number(target.value);
        networkBucket = -1;
        page = 0;
        render();
      } else if (target.id === "zone-filter") {
        filter = target.value;
        page = 0;
        updateZones();
      }
    } else if (target instanceof HTMLInputElement && target.validity.valid && target.value) {
      if (target.id === "network-bucket") {
        selectNetworkBucket(Number(target.value));
      } else if (target.id === "budget") {
        budgetMs = Number(target.value);
        render();
      } else if (target.id === "minimum-spike") {
        minimumSpike = Number(target.value);
        page = 0;
        render();
      }
    }
  };
  function tickAt(chart: SVGElement, clientX: number, target: EventTarget | null): number {
    const ticks = thread()?.ticks;
    if (!ticks?.length) return -1;
    const id = target instanceof SVGElement ? target.dataset.tick : undefined;
    if (id) return ticks.findIndex((tick) => tick.id === BigInt(id));
    const rect = chart.getBoundingClientRect();
    if (rect.width <= 0) return -1;
    const offset =
      Math.max(0, Math.min(1, (((clientX - rect.left) / rect.width) * 1000 - 55) / 910)) *
        Number(chart.dataset.span) +
      Number(chart.dataset.first);
    let lo = 0;
    let hi = ticks.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (Number(ticks[mid]?.offsetNs ?? 0n) < offset) lo = mid + 1;
      else hi = mid;
    }
    const previous = ticks[lo - 1];
    return previous &&
      Math.abs(Number(previous.offsetNs) - offset) <
        Math.abs(Number(ticks[lo]?.offsetNs ?? 0n) - offset)
      ? lo - 1
      : lo;
  }
  host.onpointermove = (event) => {
    if (tickPinned || event.pointerType !== "mouse") return;
    const chart =
      event.target instanceof Element ? event.target.closest<SVGElement>("#timeline") : null;
    if (!chart) return;
    const index = tickAt(chart, event.clientX, event.target);
    if (index < 0 || index === selectedTick) return;
    selectedTick = index;
    updateTick();
  };
  host.onkeydown = (event) => {
    if (!(event.target instanceof Element) || !event.target.matches("[data-flame-node]")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  };
  render();
}
