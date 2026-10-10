import { MAX_BYTES, ReportError } from "./parser/qpulse.ts";

export const MAX_SHARE_BYTES = 48 * 1024;
const MAX_FRAGMENT = (MAX_SHARE_BYTES * 4) / 3 + 2048;
const tooLarge = () =>
  new ReportError("This capture is too large for a link. Share the .qpulse file instead.");

export async function createShareLink(
  file: File,
  pageURL: string,
  sample: boolean,
): Promise<string> {
  if (file.size > MAX_BYTES) throw tooLarge();
  const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const compressed = header[0] === 0x1f && header[1] === 0x8b;
  if (compressed && file.size > MAX_SHARE_BYTES) throw tooLarge();
  const reader = (
    compressed ? file.stream() : file.stream().pipeThrough(new CompressionStream("gzip"))
  ).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SHARE_BYTES) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let binary = "";
  for (const chunk of chunks) for (const byte of chunk) binary += String.fromCharCode(byte);
  const payload = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const params = new URLSearchParams({ pulse: `v1.${payload}`, name: file.name.slice(0, 160) });
  if (sample) params.set("sample", "1");
  const url = new URL(pageURL);
  url.search = "";
  url.hash = params.toString();
  return url.href;
}

export function readShareLink(hash: string): { file: File; sample: boolean } | undefined {
  if (!hash.startsWith("#pulse=")) return;
  const invalid = () =>
    new ReportError(
      "This share link is invalid or incomplete. Ask for a new link or the .qpulse file.",
    );
  if (hash.length > MAX_FRAGMENT) throw invalid();
  const params = new URLSearchParams(hash.slice(1));
  for (const key of params.keys()) {
    if (!["pulse", "name", "sample"].includes(key) || params.getAll(key).length !== 1)
      throw invalid();
  }
  const payload = params.get("pulse")?.match(/^v1\.([A-Za-z0-9_-]+)$/)?.[1];
  const name = params.get("name") ?? "shared-capture.qpulse";
  const sample = params.get("sample");
  if (
    !payload ||
    payload.length % 4 === 1 ||
    Math.floor((payload.length * 3) / 4) > MAX_SHARE_BYTES ||
    name.length > 160 ||
    (sample !== null && sample !== "1")
  )
    throw invalid();
  const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw invalid();
  return { file: new File([bytes], name), sample: sample === "1" };
}
