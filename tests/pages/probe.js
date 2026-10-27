/**
 * Layout probe: measures what the screenshots can only suggest - how wide the
 * tables want to be, whether the frames scroll at each width, and what the
 * section heads actually say.
 *
 *   node tests/pages/probe.js
 */

"use strict";

const { chromium } = require("playwright");
const path = require("path");

const BASE = "http://127.0.0.1:18210";
const CLIENT_ID = "b3f1a2c4d5e6f7a8";
const HEADLESS_SHELL =
  process.env.CHROMIUM_PATH ||
  path.join(
    process.env.HOME,
    ".cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
  );

function measure(page, label) {
  return page
    .evaluate(() => {
      const frame = document.getElementById("records-frame");
      const table = frame ? frame.querySelector("table") : null;
      const headers = table
        ? Array.from(table.querySelectorAll("thead th")).map(th => ({
            label: th.textContent.trim(),
            width: Math.round(th.getBoundingClientRect().width)
          }))
        : [];
      const kpis = Array.from(document.querySelectorAll(".kpi")).map(kpi =>
        Math.round(kpi.getBoundingClientRect().width)
      );
      const rows = [];
      document.querySelectorAll(".kpi-strip").forEach(strip => rows.push(Array.from(strip.children).length));
      return {
        viewport: window.innerWidth,
        rootFont: getComputedStyle(document.documentElement).fontSize,
        main: document.querySelector("main").clientWidth,
        console: document.querySelector(".console").clientWidth,
        pageScroll: document.documentElement.scrollWidth,
        frame: frame ? { client: frame.clientWidth, scroll: frame.scrollWidth } : null,
        table: table ? Math.round(table.getBoundingClientRect().width) : null,
        headers: headers,
        kpiWidths: kpis,
        kpiPerStrip: rows,
        heads: Array.from(document.querySelectorAll(".section-head")).map(head =>
          head.textContent.replace(/\s+/g, " ").trim()
        )
      };
    })
    .then(result => {
      console.log("\n=== " + label + " ===");
      console.log(JSON.stringify(result, null, 1));
    });
}

(async function main() {
  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL });

  for (const width of [1300, 390]) {
    const context = await browser.newContext({ viewport: { width: width, height: 950 } });
    await context.addInitScript(id => window.localStorage.setItem("librespeedex.clientId", id), CLIENT_ID);

    const records = await context.newPage();
    await records.goto(BASE + "/my-results.html");
    await records.waitForSelector("#records-body tr");
    await measure(records, "my-results " + width);

    const admin = await context.newPage();
    await admin.goto(BASE + "/results/admin.html");
    await admin.waitForSelector("#login-form:not([hidden])");
    await admin.fill("#password", "librespeed");
    await admin.click("#login-submit");
    await admin.waitForSelector("#records-body tr");
    await admin.waitForFunction(() => document.getElementById("kpi-total").textContent !== "");
    await measure(admin, "admin " + width);

    await context.close();
  }

  await browser.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
