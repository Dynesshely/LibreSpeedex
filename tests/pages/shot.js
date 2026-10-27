/**
 * Loads both new pages against the stub server and photographs them at a
 * desktop and a phone width. Collects page errors and console errors, because a
 * screenshot that looks right can still be a page that threw.
 *
 *   node tests/pages/shot.js
 *
 * Expects stub-server.js on 18210, and a second one with ADMIN_CONFIGURED=0 on
 * 18211 for the "admin is not configured" gate.
 */

"use strict";

const { chromium } = require("playwright");
const path = require("path");

const BASE = "http://127.0.0.1:18210";
const NO_CONFIG_BASE = "http://127.0.0.1:18211";
const OUT = __dirname;
const CLIENT_ID = "b3f1a2c4d5e6f7a8";
const PASSWORD = "librespeed";
const DESKTOP = { width: 1300, height: 950 };
const PHONE = { width: 390, height: 844 };

const problems = [];

function watch(page, label) {
  page.on("pageerror", error => problems.push(label + " pageerror: " + error.message));
  page.on("console", message => {
    if (message.type() === "error") problems.push(label + " console: " + message.text());
  });
}

async function shot(page, name, options) {
  const file = path.join(OUT, name + ".png");
  await page.screenshot(Object.assign({ path: file, fullPage: true }, options || {}));
  console.log("shot " + name + ".png");
}

async function recordsPage(browser, viewport, clientId, label) {
  const context = await browser.newContext({ viewport: viewport });
  if (clientId) {
    await context.addInitScript(id => {
      window.localStorage.setItem("librespeedex.clientId", id);
    }, clientId);
  }
  const page = await context.newPage();
  watch(page, label);
  await page.goto(BASE + "/my-results.html", { waitUntil: "load" });
  return { context: context, page: page };
}

async function adminPage(browser, viewport, label, base) {
  const context = await browser.newContext({ viewport: viewport });
  const page = await context.newPage();
  watch(page, label);
  await page.goto((base || BASE) + "/results/admin.html", { waitUntil: "load" });
  return { context: context, page: page };
}

async function login(page) {
  await page.waitForSelector("#login-form:not([hidden])");
  await page.fill("#password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector("#records-body tr");
  await page.waitForFunction(() => document.getElementById("kpi-total").textContent !== "");
}

/* The repo's playwright expects chromium 1217; the machine has 1234 in the
   shared browser cache. Launching the cached binary by path keeps this from
   needing a download. */
const HEADLESS_SHELL =
  process.env.CHROMIUM_PATH ||
  path.join(
    process.env.HOME,
    ".cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
  );

(async function main() {
  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL });

  /* ------------------------------------------------ my records: populated */

  const wide = await recordsPage(browser, DESKTOP, CLIENT_ID, "my-results 1300");
  await wide.page.waitForSelector("#records-body tr");
  await shot(wide.page, "my-results-1300");

  await wide.page.click("#records-body tr:nth-child(2)");
  await wide.page.waitForSelector("#detail:not([hidden])");
  await wide.page.waitForTimeout(250);
  await shot(wide.page, "my-results-detail-1300");

  /* the two step clear confirmation */
  await wide.page.click("#clear-id");
  await wide.page.waitForSelector("#clear-hint:not([hidden])");
  await shot(wide.page, "my-results-clear-confirm-1300");
  await wide.page.click("#clear-cancel");
  await wide.context.close();

  /* ------------------------------------------------- my records: 390 wide */

  const narrow = await recordsPage(browser, PHONE, CLIENT_ID, "my-results 390");
  await narrow.page.waitForSelector("#records-body tr");
  await shot(narrow.page, "my-results-390");
  const scrollWidth = await narrow.page.evaluate(() => {
    const frame = document.getElementById("records-frame");
    return { frame: frame.scrollWidth, client: frame.clientWidth, page: document.documentElement.scrollWidth };
  });
  console.log("my-results 390 scroll metrics: " + JSON.stringify(scrollWidth));
  await narrow.context.close();

  /* ------------------------------------------- my records: empty and 429 */

  const empty = await recordsPage(browser, DESKTOP, null, "my-results empty");
  await empty.page.waitForSelector("#state:not([hidden])");
  await shot(empty.page, "my-results-empty-1300");
  await empty.context.close();

  const limited = await recordsPage(browser, DESKTOP, "rate-limited", "my-results 429");
  await limited.page.waitForFunction(() => document.getElementById("header-status").textContent === "rate limited");
  await shot(limited.page, "my-results-rate-limited-1300");
  await limited.context.close();

  /* ------------------------------------------------------------ admin */

  const admin = await adminPage(browser, DESKTOP, "admin 1300");
  await admin.page.waitForSelector("#login-form:not([hidden])");
  await shot(admin.page, "admin-login-1300");

  await admin.page.fill("#password", "not-the-password");
  await admin.page.click("#login-submit");
  await admin.page.waitForSelector("#login-error:not([hidden])");
  await shot(admin.page, "admin-login-bad-password-1300");

  await login(admin.page);
  await admin.page.waitForTimeout(300);
  await shot(admin.page, "admin-1300");

  const chart = await admin.page.$(".chart-canvas-wrap");
  await chart.screenshot({ path: path.join(OUT, "admin-chart-1300.png") });
  console.log("shot admin-chart-1300.png");

  await admin.page.click("#records-body tr:nth-child(2) button[data-action=detail]");
  await admin.page.waitForSelector("#detail:not([hidden])");
  await admin.page.waitForFunction(() => document.getElementById("detail-log").textContent.length > 10);
  await shot(admin.page, "admin-detail-1300");

  await admin.page.click("#records-body tr:nth-child(3) button[data-action=delete]");
  await admin.page.waitForSelector(".confirm-row");
  await shot(admin.page, "admin-delete-confirm-1300");
  await admin.page.click(".confirm-row button[data-action=delete-cancel]");
  const cancelled = await admin.page.evaluate(() => ({
    confirmRows: document.querySelectorAll(".confirm-row").length,
    range: document.getElementById("list-range").textContent
  }));
  console.log("after cancel: " + JSON.stringify(cancelled));

  /* filters: a search that matches fewer rows, then the export link */
  await admin.page.fill("#f-q", "Fibre House");
  await admin.page.click("#apply");
  await admin.page.waitForFunction(() => document.getElementById("list-range").textContent.indexOf("showing") === 0);
  await shot(admin.page, "admin-filtered-1300");
  const exportHref = await admin.page.getAttribute("#export", "href");
  console.log("export href: " + exportHref);
  await admin.page.click("#reset");
  await admin.page.waitForTimeout(300);

  /* a lapsed session must drop back to the gate */
  await admin.context.clearCookies();
  await admin.page.click("#page-next");
  await admin.page.waitForSelector("#login-form:not([hidden])");
  await shot(admin.page, "admin-unauthorized-1300");
  await admin.context.close();

  /* ------------------------------------------------------ admin: 390 wide */

  const adminNarrow = await adminPage(browser, PHONE, "admin 390");
  await adminNarrow.page.waitForSelector("#login-form:not([hidden])");
  await shot(adminNarrow.page, "admin-login-390");
  await login(adminNarrow.page);
  await adminNarrow.page.waitForTimeout(300);
  await shot(adminNarrow.page, "admin-390");
  await adminNarrow.context.close();

  /* --------------------------------------------- admin: not configured */

  const noConfig = await adminPage(browser, DESKTOP, "admin noconfig", NO_CONFIG_BASE);
  await noConfig.page.waitForSelector("#gate-note.is-warn");
  await shot(noConfig.page, "admin-noconfig-1300");
  await noConfig.context.close();

  /* ---------------------------------------------------- maintenance notes */

  const maintenance = await adminPage(browser, DESKTOP, "admin maintenance");
  await login(maintenance.page);
  /* a real delete, all the way through */
  const beforeDelete = await maintenance.page.textContent("#list-range");
  await maintenance.page.click("#records-body tr:nth-child(1) button[data-action=delete]");
  await maintenance.page.waitForSelector(".confirm-row");
  const sentence = await maintenance.page.textContent(".confirm-row");
  console.log("confirm sentence: " + sentence.replace(/\s+/g, " ").trim());
  await maintenance.page.click(".confirm-row button[data-action=delete-confirm]");
  await maintenance.page.waitForSelector("#action-note.is-ready");
  console.log(
    "delete: " +
      beforeDelete +
      " -> " +
      (await maintenance.page.textContent("#list-range")) +
      " | note: " +
      (await maintenance.page.textContent("#action-note")).replace(/\s+/g, " ").trim()
  );

  await maintenance.page.fill("#purge-all-confirm", "purge");
  await maintenance.page.click("#purge-all-run");
  await maintenance.page.waitForSelector("#purge-all-note.is-warn");
  await maintenance.page.fill("#purge-before", "2026-09-01");
  await maintenance.page.click("#purge-before-run");
  await maintenance.page.waitForSelector("#purge-before-note.is-warn");
  await maintenance.page.locator("#maintenance").screenshot({ path: path.join(OUT, "admin-maintenance-1300.png") });
  console.log("shot admin-maintenance-1300.png");

  /* and a real purge, typed confirmation and all */
  await maintenance.page.fill("#purge-all-confirm", "PURGE");
  await maintenance.page.click("#purge-all-run");
  await maintenance.page.waitForSelector("#purge-all-note.is-ready");
  const purged = await maintenance.page.textContent("#purge-all-result");
  console.log("purge all result: " + purged);
  await maintenance.page.locator("#maintenance").screenshot({ path: path.join(OUT, "admin-purged-1300.png") });
  console.log("shot admin-purged-1300.png");
  await maintenance.context.close();

  await browser.close();

  if (problems.length) {
    console.log("\nPAGE PROBLEMS (" + problems.length + "):");
    problems.forEach(problem => console.log("  - " + problem));
    process.exitCode = 1;
  } else {
    console.log("\nno page errors, no console errors");
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
