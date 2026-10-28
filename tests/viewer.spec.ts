import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const fixture = "tests/fixtures/quark-v1.qpulse";

test("security policy blocks injected scripts, external requests and base URLs", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    expect.stringContaining("script-src 'self'"),
  );
  const violations = await page.evaluate(async () => {
    const blocked: string[] = [];
    const violations = new Promise<void>((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) => {
        blocked.push(event.effectiveDirective);
        if (["script-src-elem", "connect-src", "base-uri"].every((name) => blocked.includes(name)))
          resolve();
      });
    });
    const script = document.createElement("script");
    script.textContent = "window.compromised = true";
    document.head.append(script);
    const base = document.createElement("base");
    base.href = "https://example.com/";
    document.head.append(base);
    await fetch("https://example.com/capture").catch(() => {});
    await violations;
    return { blocked, baseURI: document.baseURI };
  });
  expect(await page.evaluate("window.compromised")).toBeUndefined();
  expect(violations.baseURI).toBe(page.url());
  expect(violations.blocked).toEqual(
    expect.arrayContaining(["script-src-elem", "connect-src", "base-uri"]),
  );
  await page.getByRole("button", { name: "Explore sample" }).click();
  await expect(page.getByRole("status")).toHaveText("Report loaded.");
});

test("v2 network evidence is inspectable, session-filtered and shareable", async ({ page }) => {
  await page.goto("/");
  await page.locator("#report-file").setInputFiles("tests/fixtures/network-v2.qpulse");
  await page.locator('.nav-item[data-view="Network"]').click();
  await expect(page.locator("footer")).toHaveText("Format v2Source");
  await expect(page.locator(".metric").filter({ hasText: "Recorded packets" })).toContainText(
    "437",
  );
  await expect(page.locator(".metric").filter({ hasText: "Recorded events" })).toContainText("4");
  await expect(page.locator(".metric").filter({ hasText: "Decoding failures" })).toContainText(
    "14",
  );
  await expect(page.locator(".network-events tbody tr")).toHaveCount(4);
  await expect(page.locator(".network-events tbody tr").nth(1)).toContainText("-1");
  await expect(page.locator(".tick-detail")).toContainText("partial");
  await page.locator('[data-network-bucket="3"]').click();
  await expect(page.locator(".tick-detail")).toContainText("324 packets");
  await page.mouse.move(0, 0);
  await expect(page.locator(".tick-detail")).toContainText("324 packets");
  await page.getByRole("slider", { name: "Select activity bucket" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".tick-detail")).toContainText("18 packets");
  await expect(page.getByRole("slider", { name: "Select activity bucket" })).toBeFocused();
  await page.locator("#network-bucket").evaluate((slider: HTMLInputElement) => {
    slider.value = "3";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#network-bucket-detail")).toContainText("324 packets");
  await expect(page.getByRole("slider", { name: "Select activity bucket" })).toBeFocused();
  await page.getByLabel("Session", { exact: true }).selectOption("2");
  await expect(page.locator(".metric").filter({ hasText: "Recorded packets" })).toContainText("8");
  await expect(page.locator(".network-events tbody tr")).toHaveCount(3);
  await expect(page.locator(".network-toolbar")).toContainText("Protocol 1000, closed");
  await page.getByLabel("Session", { exact: true }).selectOption("unknown");
  await expect(page.locator("#view-content")).toContainText("No activity windows were retained");
  await page.getByLabel("Session", { exact: true }).selectOption("all");
  await page.getByText("How to read this evidence", { exact: true }).click();
  await expect(page.locator(".network-notes")).toContainText(
    "a rejection and a separate disconnect",
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/network-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  const link = await page.getByLabel("Share link", { exact: true }).inputValue();
  await page.goto("about:blank");
  await page.goto(link);
  await page.locator('.nav-item[data-view="Network"]').click();
  await expect(page.locator(".network-events tbody tr")).toHaveCount(4);
  await page.locator("#report-file").setInputFiles(fixture);
  await expect(page.locator("#filename")).toHaveText("quark-v1.qpulse");
  await page.locator('.nav-item[data-view="Network"]').click();
  await expect(page.locator("#view-content")).toContainText(
    "Network telemetry is unavailable in Pulse v1",
  );
  await expect(page.locator("footer")).toHaveText("Format v1Source");
});

test.describe("Touch network", () => {
  test.use({ hasTouch: true });
  test("network telemetry losses stay visible and decision tables stay bounded on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    const raw = JSON.parse(
      gunzipSync(readFileSync("tests/fixtures/network-v2.qpulse")).toString("utf8"),
    );
    const network = raw.threads[0].network;
    network.events = Array.from({ length: 150 }, () => [...network.events[0]]);
    network.events_dropped = 5;
    network.windows_dropped = 7;
    network.sessions_dropped = 2;
    network.counter_overflows = 1;
    await page.goto("/");
    await page.locator("#report-file").setInputFiles({
      name: "losses.qpulse",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(raw)),
    });
    await page.locator('.nav-item[data-view="Network"]').click();
    await expect(page.locator("#view-content .notice")).toContainText("Telemetry is incomplete");
    await expect(page.locator(".metric").filter({ hasText: "Recorded packets" })).toContainText(
      "≥ 437",
    );
    await page.locator('.traffic-bar[data-network-bucket="3"]').tap();
    await expect(page.locator(".tick-detail")).toContainText("324 packets");
    await page.mouse.move(0, 0);
    await expect(page.locator(".tick-detail")).toContainText("324 packets");
    await expect(page.locator(".network-events tbody tr")).toHaveCount(75);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator(".pagination")).toContainText("76–150 of 150");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page.locator(".sidebar nav").evaluate((nav) => nav.scrollWidth <= nav.clientWidth),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "test-results/network-mobile.png" });
  });
});

test("large network captures bound charts and reset activity selection on thread change", async ({
  page,
}) => {
  const raw = JSON.parse(
    gunzipSync(readFileSync("tests/fixtures/network-v2.qpulse")).toString("utf8"),
  );
  const thread = raw.threads[0];
  const length = 4_095_750_000_000;
  thread.ended_ns = thread.started_ns + length;
  thread.network.coverage.to_ns = length;
  thread.network.windows = Array.from({ length: 4096 }, (_, index) => [
    index * 1_000_000_000,
    1,
    1,
    index === 3072 ? 900 : 10,
    40,
    80,
    10,
    0,
    0,
    0,
    0,
  ]);
  raw.threads.push({
    ...thread,
    thread: "empty-network",
    network: { ...thread.network, sessions: [], events: [], windows: [] },
  });
  await page.goto("/");
  await page.locator("#report-file").setInputFiles({
    name: "large-network.qpulse",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(raw)),
  });
  await page.locator('.nav-item[data-view="Network"]').click();
  expect(await page.locator(".traffic-bar").count()).toBeLessThanOrEqual(240);
  await expect(page.locator('.traffic-bar[data-network-bucket="3072"]')).toHaveCount(1);
  await page.locator('.traffic-bar[data-network-bucket="3072"]').click();
  await expect(page.locator(".tick-detail")).toContainText("900 packets");
  await page.getByRole("combobox", { name: "Thread", exact: true }).selectOption("1");
  await expect(page.locator(".traffic-bar")).toHaveCount(0);
  await expect(page.locator("#view-content")).toContainText("No activity windows were retained");
  await page.getByRole("combobox", { name: "Thread", exact: true }).selectOption("0");
  await expect(page.getByLabel("Session", { exact: true })).toHaveValue("all");
  await expect(page.getByRole("slider", { name: "Select activity bucket" })).toHaveValue("4095");
});

test("share dialog copies a capture that reopens without uploading", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          Reflect.set(window, "copiedLink", value);
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeHidden();
  await page.locator("#report-file").setInputFiles({
    name: "capture.qpulse",
    mimeType: "application/json",
    buffer: gunzipSync(readFileSync(fixture)),
  });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  const link = await page.getByLabel("Share link", { exact: true }).inputValue();
  expect(new URL(link).hash).toMatch(/^#pulse=v1\./);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.locator("#share-message")).toHaveText("Link copied.");
  expect(await page.evaluate(() => Reflect.get(window, "copiedLink"))).toBe(link);
  await page.screenshot({ path: "test-results/share-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeFocused();
  const recipient = await page.context().newPage();
  const requests: { method: string; url: string }[] = [];
  recipient.on("request", (request) =>
    requests.push({ method: request.method(), url: request.url() }),
  );
  try {
    await recipient.goto(link);
    await expect(recipient.locator("#filename")).toHaveText("capture.qpulse");
    await expect(recipient.locator(".metric").filter({ hasText: "Average tick" })).toContainText(
      "42.50 ms",
    );
    await expect(recipient.locator("#metadata")).toContainText("6.0.0");
    expect(
      requests.every((request) => request.method === "GET" && !request.url.includes("pulse=v1")),
    ).toBe(true);
    await recipient.locator("#report-file").setInputFiles("tests/fixtures/empty-v1.qpulse");
    await expect(recipient.locator("#filename")).toHaveText("empty-v1.qpulse");
    expect(new URL(recipient.url()).hash).toBe("");
  } finally {
    await recipient.close();
  }
});

test("sharing remains usable on mobile when clipboard access fails or a capture is too large", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
    });
  });
  await page.goto("/");
  await page.locator("#report-file").setInputFiles(fixture);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.locator("#share-message")).toContainText("Copy the selected link manually");
  const field = page.getByLabel("Share link", { exact: true });
  await expect(field).toBeFocused();
  expect(
    await field.evaluate(
      (input: HTMLInputElement) =>
        input.selectionStart === 0 && input.selectionEnd === input.value.length,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/share-mobile.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const zones = Array.from({ length: 1300 }, () => randomBytes(48).toString("hex"));
  const buffer = gzipSync(
    gunzipSync(readFileSync(fixture))
      .toString("utf8")
      .replace(
        '"server.tick"',
        ['"server.tick"', ...zones.map((name) => JSON.stringify(name))].join(","),
      ),
  );
  expect(buffer.byteLength).toBeGreaterThan(48 * 1024);
  await page
    .locator("#report-file")
    .setInputFiles({ name: "large.qpulse", mimeType: "application/octet-stream", buffer });
  await expect(page.locator("#filename")).toHaveText("large.qpulse");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.locator("#share-message")).toContainText("too large for a link");
  await expect(page.getByRole("button", { name: "Copy link" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeFocused();
});

test("shared captures preserve valid reports on error and queue links during import", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#report-file").setInputFiles(fixture);
  await expect(page.locator("#filename")).toHaveText("quark-v1.qpulse");
  for (const [payload, message] of [
    ["v2.H4s", "This share link is invalid or incomplete. Ask for a new link or the .qpulse file."],
    ["v1.H4s", "Corrupt, truncated, or unsupported gzip report."],
    [
      `v1.${gzipSync(" ".repeat(8_388_609)).toString("base64url")}`,
      "Decompressed report exceeds the 8 MiB limit.",
    ],
  ]) {
    await page.evaluate((payload) => {
      location.hash = `pulse=${payload}`;
    }, payload);
    await expect(page.getByRole("alert")).toHaveText(message ?? "");
    await expect(page.locator("#filename")).toHaveText("quark-v1.qpulse");
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeEnabled();
  }
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  expect(new URL(await page.getByLabel("Share link", { exact: true }).inputValue()).hash).toContain(
    "name=quark-v1.qpulse",
  );
  await page.keyboard.press("Escape");
  let releaseWorker!: () => void;
  let workerRequested!: () => void;
  const gate = new Promise<void>((done) => {
    releaseWorker = done;
  });
  const requested = new Promise<void>((done) => {
    workerRequested = done;
  });
  await page.route("**/assets/worker-*.js", async (route) => {
    workerRequested();
    await gate;
    await route.continue();
  });
  try {
    await page.locator("#report-file").setInputFiles(fixture);
    await requested;
    const hash = `#pulse=v1.${readFileSync("tests/fixtures/empty-v1.qpulse").toString("base64url")}&name=linked-empty.qpulse`;
    await page.evaluate(async (hash) => {
      await new Promise<void>((done) => {
        window.addEventListener("hashchange", () => done(), { once: true });
        location.hash = hash;
      });
    }, hash);
    releaseWorker();
    await expect(page.locator("#filename")).toHaveText("linked-empty.qpulse");
    expect(new URL(page.url()).hash).toBe(hash);
  } finally {
    releaseWorker();
  }
});

test("browser inflater rejects corrupt, truncated, concatenated and oversized gzip", async ({
  page,
}) => {
  await page.goto("/");
  const bytes = readFileSync(fixture);
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 8] = (corrupt[corrupt.length - 8] ?? 0) ^ 0xff;
  for (const buffer of [
    bytes.subarray(0, -1),
    corrupt,
    Buffer.concat([bytes, bytes]),
    Buffer.concat([bytes, Buffer.from("trailing")]),
    gzipSync(" ".repeat(8_388_609)),
  ]) {
    await page.locator("#report-file").setInputFiles({
      name: "broken.qpulse",
      mimeType: "application/octet-stream",
      buffer,
    });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open .qpulse report" })).toBeEnabled();
    await expect(page.locator("#report-summary")).toBeHidden();
  }
});

test("loads Quark reports, preserves the last capture on error, and accepts another report", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const input = page.locator("#report-file");
  await input.setInputFiles(fixture);
  await expect(page.getByRole("status")).toHaveText("Report loaded.");
  await expect(page.locator("#filename")).toHaveText("quark-v1.qpulse");
  await expect(page.locator("#metadata")).toContainText("6.0.0");
  await input.setInputFiles({
    name: "broken.qpulse",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("{}"),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("#filename")).toHaveText("quark-v1.qpulse");
  await expect(page.getByRole("button", { name: "Open another report" })).toBeEnabled();
  await input.setInputFiles("tests/fixtures/empty-v1.qpulse");
  await expect(page.getByRole("status")).toHaveText("Report loaded.");
  await expect(page.locator("#filename")).toHaveText("empty-v1.qpulse");
  expect(errors).toEqual([]);
});

test("repeated imports terminate their workers and do not upload report data", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" || !request.url().startsWith("http://127.0.0.1:4173/"))
      requests.push(request.url());
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const active = new Set<Worker>();
    Object.assign(window, { activeParserWorkers: () => active.size });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        active.add(this);
      }
      terminate() {
        active.delete(this);
        super.terminate();
      }
    };
  });
  await page.goto("/");
  for (let i = 0; i < 10; i++) {
    await page.locator("#report-file").setInputFiles(fixture);
    await expect(page.getByRole("status")).toHaveText("Report loaded.");
    await expect(page.locator("#report-file")).toHaveValue("");
    expect(await page.evaluate("window.activeParserWorkers()")).toBe(0);
  }
  await page.locator("#report-file").setInputFiles({
    name: "bad.qpulse",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("bad"),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.evaluate("window.activeParserWorkers()")).toBe(0);
  expect(requests).toEqual([]);
});

test("drop imports display filenames as text", async ({ page }) => {
  await page.route("**/test-fixture.qpulse", (route) => route.fulfill({ path: fixture }));
  await page.goto("/");
  await page.evaluate(async () => {
    const bytes = await fetch("/test-fixture.qpulse").then((response) => response.arrayBuffer());
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "<img src=x onerror=alert(1)>.qpulse"));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
  });
  await expect(page.getByRole("status")).toHaveText("Report loaded.");
  await expect(page.locator("#filename")).toHaveText("<img src=x onerror=alert(1)>.qpulse");
  await expect(page.locator("#filename img")).toHaveCount(0);
});

for (const width of [375, 768, 1440]) {
  test(`keyboard focus and layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Pulse Viewer home" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Open .qpulse report" })).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/welcome-${width}.png` });
    await page.locator("#report-file").setInputFiles(fixture);
    await expect(page.getByRole("status")).toHaveText("Report loaded.");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/import-${width}.png`,
      fullPage: true,
    });
  });
}

test("metrics, timeline, hotspot sorting, tree expansion, flame zoom, spikes and thread selection", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#report-file").setInputFiles(fixture);
  await expect(page.locator("#drop-zone")).toBeHidden();
  await expect(page.locator("footer")).toHaveText("Format v1Source");
  await expect(page.locator(".live-dot, .category-dot, .welcome-facts")).toHaveCount(0);
  expect(
    await page
      .locator(".metric strong")
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("Segoe UI");

  await expect(page.locator(".metric").filter({ hasText: "Average tick" })).toContainText(
    "42.50 ms",
  );
  await expect(page.locator(".metric").filter({ hasText: "P95 tick" })).toContainText("60.00 ms");
  await expect(page.locator(".metric").filter({ hasText: "Maximum tick" })).toContainText(
    "80.00 ms",
  );
  await expect(page.locator("#tick-detail")).toContainText("#4");
  await expect(page.locator(".chart-help")).toContainText("Higher peaks mean slower ticks");
  await expect(page.locator("#tick-detail")).toContainText("s into capture");
  await expect(page.locator("#tick-detail")).toContainText("Above target");
  await page.getByRole("spinbutton", { name: "Target tick time in milliseconds" }).fill("70");
  await page.getByRole("spinbutton", { name: "Target tick time in milliseconds" }).press("Tab");
  await expect(page.locator("#tick-detail")).toContainText("Within target");
  await expect(page.locator(".panel-heading").first()).toContainText("0 exceed the 70 ms target");

  await page.getByRole("button", { name: "Previous tick" }).click();
  await expect(page.locator("#tick-detail")).toContainText("#3");
  await page.getByRole("slider", { name: "Select a tick" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tick-detail")).toContainText("#4");
  await page.getByRole("button", { name: "Inspect spike ↗" }).click();
  await expect(page.locator("#spike-detail h2")).toHaveText("Tick #4");
  await expect(page.locator("#spike-detail tbody")).toContainText("event.SkyWars.PlayerMoveEvent");
  await page.locator('[data-select-spike="2"]').click();
  await expect(page.locator('[data-select-spike="2"]')).toBeFocused();
  await expect(page.locator(".neighbors")).toContainText("#3");
  await expect(page.locator('.neighbors [data-history-tick="2"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Hotspots", exact: false }).first().click();
  await expect(page.locator("tbody tr").first()).toContainText("event.SkyWars.PlayerMoveEvent");
  await page.getByRole("button", { name: "Self ↓", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toContainText("plugin.SkyWars");
  await page.getByLabel("Zone category").selectOption("World");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Zone category").selectOption("All zones");
  await page.locator(".page-heading h1").click();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("searchbox").fill("server");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("searchbox").fill("");
  await page.locator('[data-view="Call tree"]').click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await page.getByRole("button", { name: "Collapse server.tick", exact: true }).click();
  await expect(page.locator('[data-node="1"]')).toBeFocused();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("searchbox").fill("PlayerMove");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Flame view" }).click();
  await expect(page.locator(".flame-graph")).toBeVisible();
  await page.locator('[data-flame-node="3"]').click();
  await expect(page.locator(".flame-heading")).toContainText("plugin.SkyWars");
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.getByRole("combobox", { name: "Thread", exact: true }).selectOption("1");
  await page.locator('[data-view="Overview"]').first().click();
  await expect(page.locator("#view-content")).toContainText("No tick history");
  await expect(page.locator(".metric").filter({ hasText: "P95 tick" })).toContainText("—");
  await page.locator('[data-view="Threads"]').click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.locator('[data-thread="0"]').click();
  await expect(page.getByRole("combobox", { name: "Thread", exact: true })).toHaveValue("0");
});

for (const touch of [false, true]) {
  test.describe(touch ? "Touch timeline" : "Mouse timeline", () => {
    test.use({
      hasTouch: touch,
      viewport: touch ? { width: 375, height: 900 } : { width: 1440, height: 1050 },
    });
    test("pins a tick until hover is resumed and resets on thread change", async ({ page }) => {
      await page.goto("/");
      await page.locator("#report-file").setInputFiles(fixture);
      const chart = page.locator("#timeline");
      const detail = page.locator("#tick-detail");
      await chart.scrollIntoViewIfNeeded();
      const bounds = await chart.boundingBox();
      if (!bounds) throw new Error("Timeline is not visible");
      const first = { x: bounds.width * 0.055, y: bounds.height * 0.65 };
      const last = { x: bounds.width * 0.965, y: bounds.height * 0.26 };
      if (touch) await chart.tap({ position: first });
      else await chart.click({ position: first });
      await expect(detail).toContainText("Pinned tick #3");
      await page.mouse.move(bounds.x + last.x, bounds.y + last.y);
      await expect(detail).toContainText("Pinned tick #3");
      if (touch) await page.locator(".slow-point").last().tap();
      else await page.locator(".slow-point").last().click();
      await expect(detail).toContainText("Pinned tick #4");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.getByRole("button", { name: "Inspect spike ↗" }).click();
      await expect(page.locator("#spike-detail h2")).toHaveText("Tick #4");
      await page.locator('.nav-item[data-view="Overview"]').click();
      await page.getByRole("button", { name: "Previous tick" }).click();
      await expect(detail).toContainText("Pinned tick #3");
      await page.getByRole("slider", { name: "Select a tick" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(detail).toContainText("Pinned tick #4");
      await page.getByRole("spinbutton", { name: "Target tick time in milliseconds" }).fill("70");
      await page.getByRole("spinbutton", { name: "Target tick time in milliseconds" }).press("Tab");
      await expect(detail).toContainText("Pinned tick #4");
      await page.getByRole("button", { name: "Resume hover" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("slider", { name: "Select a tick" })).toBeFocused();
      await expect(page.getByRole("button", { name: "Resume hover" })).toBeHidden();
      await chart.scrollIntoViewIfNeeded();
      const currentBounds = await chart.boundingBox();
      if (!currentBounds) throw new Error("Timeline is not visible");
      await page.mouse.move(currentBounds.x + first.x, currentBounds.y + first.y);
      await expect(detail).toContainText("Tick #3");
      await page.getByRole("button", { name: "Next tick" }).click();
      await expect(detail).toContainText("Pinned tick #4");
      await page.getByRole("combobox", { name: "Thread", exact: true }).selectOption("1");
      await expect(chart).toHaveCount(0);
      await page.getByRole("combobox", { name: "Thread", exact: true }).selectOption("0");
      await expect(page.getByRole("button", { name: "Resume hover" })).toBeHidden();
    });
  });
}

test("sample capture and every analysis view remain usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/");
  await expect(page.locator("#report-summary")).toBeHidden();
  await expect(page.locator(".welcome-facts, .live-dot")).toHaveCount(0);
  await page.screenshot({ path: "test-results/welcome-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Explore sample" }).click();
  await expect(page.getByRole("status")).toHaveText("Report loaded.");
  await expect(page.locator(".page-heading .capture-label")).toHaveText("Sample capture");
  await expect(page.locator(".sidebar-section")).toBeHidden();
  await expect(page.locator(".sidebar > .sidebar-label")).toBeHidden();
  await expect(page.locator('#metadata dt:has-text("Platform") + dd')).toHaveText("Linux x86_64");
  expect(
    await page
      .locator(".sidebar nav")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);

  await expect(page.locator(".metric").filter({ hasText: "Average tick" })).toContainText(
    "800 ticks",
  );
  for (const view of ["Overview", "Call tree", "Hotspots", "Spikes", "Network", "Threads"]) {
    await page.locator(`.nav-item[data-view="${view}"]`).click();
    await expect(page.locator(".page-heading h1")).toHaveText(view);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.locator('.nav-item[data-view="Overview"]').click();
  await page.locator(".slow-point").nth(1).click();
  await expect(page.locator("#tick-detail")).toContainText("Pinned tick #480");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/sample-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: "test-results/sample-desktop.png", fullPage: true });
});

test("report-controlled names stay text through navigation and search", async ({ page }) => {
  const name = '<img src="x" onerror="window.compromised=true">';
  const json = gunzipSync(readFileSync(fixture))
    .toString("utf8")
    .replace('"server.tick"', JSON.stringify(name))
    .replace('"main"', JSON.stringify(name))
    .replace('"6.0.0"', JSON.stringify(name));
  await page.goto("/");
  await page.locator("#report-file").setInputFiles({
    name: "names.qpulse",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(page.getByRole("status")).toHaveText("Report loaded.");
  await expect(page.locator("#metadata")).toContainText(name);
  await page.locator(".zone-bar").filter({ hasText: name }).click();
  await expect(page.getByRole("searchbox")).toHaveValue(name);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("#report-summary img")).toHaveCount(0);
  expect(await page.evaluate("window.compromised")).toBeUndefined();
});

test("large deep captures bound table, flame, and spike breadcrumb rendering", async ({ page }) => {
  const raw = JSON.parse(
    gunzipSync(readFileSync(fixture)).toString("utf8"),
    (_key: string, value: unknown, context?: { source: string }) =>
      typeof value === "number" ? BigInt(context?.source ?? "0") : value,
  );
  const thread = raw.threads[0];
  const count = 1000;
  thread.zones = Array.from({ length: count }, (_, index) => `zone.${index}`);
  thread.nodes = Array.from({ length: count }, (_, index) => [
    BigInt(index + 1),
    BigInt(index),
    BigInt(index),
    1n,
    10n,
    index === count - 1 ? 10n : 0n,
    10n,
  ]);
  thread.active_ticks = Array(count).fill(1n);
  thread.spikes = [
    {
      tick: [2n, 60_000_000n, 80_000_000n],
      nodes: Array.from({ length: count }, (_, index) => [
        BigInt(index + 1),
        1n,
        10n,
        index === count - 1 ? 10n : 0n,
      ]),
    },
  ];
  raw.threads = [thread];
  const rawJSON = Reflect.get(JSON, "rawJSON") as (text: string) => unknown;
  const buffer = Buffer.from(
    JSON.stringify(raw, (_key, value) =>
      typeof value === "bigint" ? rawJSON(String(value)) : value,
    ),
  );
  await page.goto("/");
  await page
    .locator("#report-file")
    .setInputFiles({ name: "deep.qpulse", mimeType: "application/json", buffer });
  await expect(page.getByRole("status")).toHaveText("Report loaded.");
  await page.locator('.nav-item[data-view="Call tree"]').click();
  await expect(page.locator("tbody tr")).toHaveCount(75);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toContainText("zone.75");
  await page.getByRole("button", { name: "Flame view" }).click();
  await expect(page.locator(".flame-graph g")).toHaveCount(16);
  await page.locator('.nav-item[data-view="Spikes"]').click();
  await expect(page.locator("tbody tr")).toHaveCount(75);
  const title = await page.locator("tbody tr").first().locator("td").first().getAttribute("title");
  expect(title?.length).toBeLessThan(400);
});

test("production assets, sample and parser worker work under a GitHub Pages subpath", async ({
  page,
}) => {
  const root = resolve("dist");
  const failures: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative =
      pathname === "/PulseViewer/" ? "index.html" : pathname.slice("/PulseViewer/".length);
    const file = resolve(root, relative);
    if (!pathname.startsWith("/PulseViewer/") || !file.startsWith(root + sep)) {
      failures.push(pathname);
      response.writeHead(404).end();
      return;
    }
    try {
      const type = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".html")
            ? "text/html"
            : "application/octet-stream";
      response.writeHead(200, { "Content-Type": type }).end(readFileSync(file));
    } catch {
      failures.push(pathname);
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    await page.goto(`http://127.0.0.1:${address.port}/PulseViewer/`);
    await page.getByRole("button", { name: "Explore sample" }).click();
    await expect(page.getByRole("status")).toHaveText("Report loaded.");
    await expect(page.locator("#filename")).toHaveText("sample-server.qpulse");
    await expect(page.locator("#timeline")).toBeVisible();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
    const link = await page.getByLabel("Share link", { exact: true }).inputValue();
    expect(new URL(link).pathname).toBe("/PulseViewer/");
    await page.goto("about:blank");
    await page.goto(link);
    await expect(page.locator("#filename")).toHaveText("sample-server.qpulse");
    await expect(page.locator(".page-heading .capture-label")).toHaveText("Sample capture");
    await expect(page.locator("#timeline")).toBeVisible();
    expect(failures).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
