import { parseInWorker } from "./parser/load.ts";
import { MAX_BYTES, ReportError } from "./parser/qpulse.ts";
import { showReport } from "./viewer.ts";
import { createShareLink, readShareLink } from "./share.ts";
import "./style.css";

const open = document.querySelector<HTMLButtonElement>("#open-report");
const input = document.querySelector<HTMLInputElement>("#report-file");
const status = document.querySelector<HTMLParagraphElement>("#status");
const main = document.querySelector<HTMLElement>("#main");
const loadingState = document.querySelector<HTMLElement>("#loading-state");
const loadingTitle = document.querySelector<HTMLElement>("#loading-title");
const error = document.querySelector<HTMLParagraphElement>("#error");
const summary = document.querySelector<HTMLElement>("#report-summary");
const filename = document.querySelector<HTMLSpanElement>("#filename");
const welcome = document.querySelector<HTMLElement>("#drop-zone");
const welcomeOpen = document.querySelector<HTMLButtonElement>("#welcome-open");
const sampleOpen = document.querySelector<HTMLButtonElement>("#sample-report");
const share = document.querySelector<HTMLButtonElement>("#share-report");
const shareDialog = document.querySelector<HTMLDialogElement>("#share-dialog");
const shareLink = document.querySelector<HTMLInputElement>("#share-link");
const shareCopy = document.querySelector<HTMLButtonElement>("#copy-share");
const shareMessage = document.querySelector<HTMLParagraphElement>("#share-message");
if (
  !open ||
  !input ||
  !status ||
  !main ||
  !loadingState ||
  !loadingTitle ||
  !error ||
  !summary ||
  !filename ||
  !welcome ||
  !welcomeOpen ||
  !sampleOpen ||
  !share ||
  !shareDialog ||
  !shareLink ||
  !shareCopy ||
  !shareMessage
) {
  throw new Error("Missing viewer elements");
}
const ui = {
  open,
  input,
  status,
  main,
  loadingState,
  loadingTitle,
  error,
  summary,
  filename,
  welcome,
  welcomeOpen,
  sampleOpen,
  share,
  shareDialog,
  shareLink,
  shareCopy,
  shareMessage,
};
let loading = false;
let currentFile: File | undefined;
let currentSample = false;
let sharePromise: Promise<string> | undefined;
let pendingHash = false;

async function load(
  source: File | (() => Promise<File>),
  sample = false,
  shared = false,
): Promise<void> {
  if (loading) return;
  const startedHash = location.hash;
  loading = true;
  document.body.classList.remove("dragging");
  ui.main.setAttribute("aria-busy", "true");
  ui.loadingState.hidden = false;
  ui.loadingTitle.textContent =
    typeof source === "function" ? "Fetching sample…" : "Reading report…";
  ui.share.disabled = true;
  ui.shareDialog.close();
  ui.open.disabled = true;
  ui.welcomeOpen.disabled = true;
  ui.sampleOpen.disabled = true;
  ui.open.textContent = "Reading report…";
  ui.error.hidden = true;
  ui.status.textContent = "Reading report…";
  try {
    const file = typeof source === "function" ? await source() : source;
    if (file.size > MAX_BYTES) throw new ReportError("Report exceeds the 8 MiB limit.");
    const bytes = await file.arrayBuffer();
    ui.loadingTitle.textContent = "Analyzing capture…";
    const report = await parseInWorker(bytes);
    showReport(ui.summary, report, sample);
    currentFile = file;
    currentSample = sample;
    sharePromise = undefined;
    if (
      !shared &&
      !pendingHash &&
      location.hash === startedHash &&
      location.hash.startsWith("#pulse=")
    )
      history.replaceState(null, "", location.pathname + location.search);
    ui.filename.textContent = file.name;
    const format = document.querySelector("footer span");
    if (format) format.textContent = `Format v${report.version}`;
    ui.summary.hidden = false;
    ui.welcome.hidden = true;
    ui.status.textContent = "Report loaded.";
  } catch (cause) {
    ui.error.textContent =
      cause instanceof ReportError
        ? cause.message
        : "Unable to read this file. Try opening the report again.";
    ui.error.hidden = false;
    ui.status.textContent = "";
  } finally {
    loading = false;
    ui.loadingState.hidden = true;
    ui.main.setAttribute("aria-busy", "false");
    ui.open.disabled = false;
    ui.welcomeOpen.disabled = false;
    ui.sampleOpen.disabled = false;
    ui.share.hidden = currentFile === undefined;
    ui.share.disabled = false;
    ui.open.textContent = ui.summary.hidden ? "Open .qpulse report" : "Open another report";
    ui.input.value = "";
    if (pendingHash) {
      pendingHash = false;
      openShared();
    }
  }
}

ui.share.addEventListener("click", async () => {
  const file = currentFile;
  if (!file || loading) return;
  ui.shareLink.value = "";
  ui.shareCopy.disabled = true;
  ui.shareCopy.textContent = "Copy link";
  ui.shareMessage.textContent = "Creating link…";
  ui.shareDialog.setAttribute("aria-busy", "true");
  ui.shareDialog.showModal();
  try {
    sharePromise ??= createShareLink(file, location.href, currentSample);
    const link = await sharePromise;
    if (currentFile !== file || !ui.shareDialog.open) return;
    ui.shareLink.value = link;
    ui.shareCopy.disabled = false;
    ui.shareMessage.textContent = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
      ? "This preview link only works on this computer. Use the hosted site to share with others."
      : "Copy the full link. Some messaging apps may shorten long links.";
    ui.shareLink.focus();
    ui.shareLink.select();
  } catch (cause) {
    if (currentFile !== file || !ui.shareDialog.open) return;
    ui.shareMessage.textContent =
      cause instanceof ReportError
        ? cause.message
        : "Unable to create a link. Share the .qpulse file instead.";
  } finally {
    if (currentFile === file) ui.shareDialog.setAttribute("aria-busy", "false");
  }
});
ui.shareLink.addEventListener("click", () => ui.shareLink.select());
ui.shareCopy.addEventListener("click", async () => {
  const link = ui.shareLink.value;
  const file = currentFile;
  if (!link || ui.shareCopy.disabled) return;
  ui.shareCopy.disabled = true;
  ui.shareCopy.textContent = "Copying…";
  try {
    await navigator.clipboard.writeText(link);
    if (currentFile === file && ui.shareDialog.open && ui.shareLink.value === link)
      ui.shareMessage.textContent = "Link copied.";
  } catch {
    if (currentFile !== file || !ui.shareDialog.open || ui.shareLink.value !== link) return;
    ui.shareMessage.textContent =
      "Copy the selected link manually. Automatic copying is unavailable.";
    ui.shareLink.focus();
    ui.shareLink.select();
  } finally {
    if (currentFile === file && ui.shareLink.value === link) {
      ui.shareCopy.disabled = false;
      ui.shareCopy.textContent = "Copy link";
    }
  }
});

function openShared(): void {
  if (loading) {
    pendingHash = true;
    return;
  }
  try {
    const capture = readShareLink(location.hash);
    if (capture) void load(capture.file, capture.sample, true);
  } catch (cause) {
    ui.error.textContent =
      cause instanceof ReportError ? cause.message : "Unable to open this share link.";
    ui.error.hidden = false;
  }
}
window.addEventListener("hashchange", openShared);
openShared();

ui.open.addEventListener("click", () => ui.input.click());
ui.welcomeOpen.addEventListener("click", () => ui.input.click());
ui.sampleOpen.addEventListener("click", () => {
  void load(async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}sample.qpulse`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new ReportError("Unable to open the sample capture.");
    return new File([await response.arrayBuffer()], "sample-server.qpulse");
  }, true);
});
document.addEventListener("keydown", (event) => {
  if (
    loading ||
    event.key !== "/" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  const search = document.querySelector<HTMLInputElement>("#zone-search");
  if (search) {
    event.preventDefault();
    search.focus();
  }
});
ui.input.addEventListener("change", () => {
  const file = ui.input.files?.[0];
  if (file) void load(file);
});
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = loading ? "none" : "copy";
  document.body.classList.toggle("dragging", !loading);
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  const files = event.dataTransfer?.files;
  if (!files?.length || loading) return;
  if (files.length !== 1) {
    ui.error.textContent = "Open one report at a time.";
    ui.error.hidden = false;
    return;
  }
  const file = files[0];
  if (file) void load(file);
});
