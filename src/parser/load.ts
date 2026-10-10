import type { PulseReport } from "../model/report.ts";
import { ReportError } from "./qpulse.ts";

export async function parseInWorker(input: ArrayBuffer): Promise<PulseReport> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<PulseReport>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new ReportError("Report parsing timed out. Try a smaller capture.")),
        30_000,
      );
      worker.onmessage = (event: MessageEvent<{ report?: PulseReport; error?: string }>) => {
        if (event.data.report) resolve(event.data.report);
        else reject(new ReportError(event.data.error ?? "Unable to parse report."));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new ReportError("Unable to start the report parser. Reload and try again."));
      };
      worker.onmessageerror = () => reject(new ReportError("Unable to receive the parsed report."));
      worker.postMessage(input, [input]);
    });
  } finally {
    clearTimeout(timeout);
    worker.terminate();
  }
}
