import { parseReport, ReportError } from "./qpulse.ts";

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ report: await parseReport(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof ReportError ? error.message : "Unable to parse this report.",
    });
  }
};
