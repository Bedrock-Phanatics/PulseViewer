/** escapes report text for html and attributes */
export function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

export function empty(message: string): string {
  return `<div class="empty"><p>${message}</p></div>`;
}

/** detail is trusted markup, escape report text first */
export function metric(label: string, value: string, detail: string, accent = false): string {
  return `<div class="metric${accent ? " accent-metric" : ""}"><span class="metric-label">${label}</span><strong>${html(value)}</strong><span class="metric-detail">${detail}</span></div>`;
}

export function panel(title: string, subtitle: string, content: string, action = ""): string {
  return `<section class="panel"><div class="panel-heading"><div><h2>${title}</h2><p>${subtitle}</p></div>${action}</div>${content}</section>`;
}

export function cpuPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

export function memory(value: bigint): string {
  const mib = Number(value) / 1_048_576;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${mib.toFixed(1)} MiB`;
}

export function hint(text: string): string {
  return `<span class="hint" tabindex="0" role="note" title="${html(text)}" aria-label="${html(text)}">?</span>`;
}
