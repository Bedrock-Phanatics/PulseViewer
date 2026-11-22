import { html } from "./ui.ts";

export type Cell = string | number | bigint | null | undefined;

export interface Column<R> {
  key: string;
  label: string;
  title?: string;
  /** null sorts last in either direction */
  value: (row: R) => Cell;
  /** trusted markup, defaults to the escaped value */
  cell?: (row: R) => string;
  text?: boolean;
}

export interface TableConfig<R> {
  id: string;
  label: string;
  columns: Column<R>[];
  rows: R[];
  search: (row: R) => string;
  defaultSort: string;
  placeholder: string;
  empty: string;
  rowAttributes?: (row: R) => string;
  pageSize?: number;
  ascending?: boolean;
}

export interface TableState {
  query: string;
  sort: string;
  descending: boolean;
  page: number;
}

const PAGE_ROWS = 50;

function compareCells(a: Cell, b: Cell): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  if (typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b));
  return a > b ? 1 : a < b ? -1 : 0;
}

export function newState(config: { defaultSort: string; ascending?: boolean }): TableState {
  return { query: "", sort: config.defaultSort, descending: !config.ascending, page: 0 };
}

export function visibleRows<R>(config: TableConfig<R>, state: TableState): R[] {
  const query = state.query.trim().toLowerCase();
  const rows = query
    ? config.rows.filter((row) => config.search(row).toLowerCase().includes(query))
    : [...config.rows];
  const column = config.columns.find((item) => item.key === state.sort);
  if (column) {
    rows.sort((a, b) => {
      const left = column.value(a);
      const right = column.value(b);
      if (left == null || right == null) return compareCells(left, right);
      return compareCells(left, right) * (state.descending ? -1 : 1);
    });
  }
  return rows;
}

export function tableBody<R>(config: TableConfig<R>, state: TableState): string {
  const rows = visibleRows(config, state);
  const size = config.pageSize ?? PAGE_ROWS;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const shown = rows.slice(state.page * size, (state.page + 1) * size);
  const head = config.columns
    .map((column) => {
      const active = state.sort === column.key;
      const sort = active ? (state.descending ? "descending" : "ascending") : "none";
      return `<th class="${column.text ? "text-column" : ""}" aria-sort="${sort}"><button data-tsort="${html(config.id)}|${html(column.key)}"${column.title ? ` title="${html(column.title)}"` : ""}>${html(column.label)}${active ? (state.descending ? " ↓" : " ↑") : ""}</button></th>`;
    })
    .join("");
  const body = shown
    .map(
      (row) =>
        `<tr${config.rowAttributes ? ` ${config.rowAttributes(row)}` : ""}>${config.columns
          .map(
            (column) =>
              `<td class="${column.text ? "text-column" : ""}">${column.cell ? column.cell(row) : html(String(column.value(row) ?? "—"))}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  const first = rows.length ? state.page * size + 1 : 0;
  return `<div class="table-scroll"><table class="data-table" aria-label="${html(config.label)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${rows.length ? "" : `<div class="empty"><p>${html(config.empty)}</p></div>`}<div class="pagination"><span>${first.toLocaleString()}–${Math.min((state.page + 1) * size, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}${state.query.trim() ? ` matching rows (${config.rows.length.toLocaleString()} total)` : " rows"}</span><div><button class="quiet" data-tpage="${html(config.id)}|-1" ${state.page === 0 ? "disabled" : ""}>Previous</button><button class="quiet" data-tpage="${html(config.id)}|1" ${state.page + 1 >= pages ? "disabled" : ""}>Next</button></div></div>`;
}

export function tableHtml<R>(config: TableConfig<R>, state: TableState): string {
  return `<div class="data-table-block" data-table="${html(config.id)}"><div class="table-toolbar"><label class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input type="search" data-tsearch="${html(config.id)}" placeholder="${html(config.placeholder)}" aria-label="${html(config.placeholder)}" value="${html(state.query)}" /></label><span class="table-count">${config.rows.length.toLocaleString()} rows</span></div><div class="table-results" id="tb-${html(config.id)}">${tableBody(config, state)}</div></div>`;
}
