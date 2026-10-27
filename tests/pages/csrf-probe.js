/**
 * Exercises the 403 bad_csrf path: the stub (STALE_CSRF=1) rejects the first
 * state changing call, so the page has to re-read the session and replay it.
 */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const HEADLESS_SHELL =
  process.env.CHROMIUM_PATH ||
  path.join(process.env.HOME, ".cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell");
(async function () {
  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL });
  const context = await browser.newContext({ viewport: { width: 1300, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:18211/results/admin.html");
  await page.waitForSelector("#login-form:not([hidden])");
  await page.fill("#password", "librespeed");
  await page.click("#login-submit");
  await page.waitForSelector("#records-body tr");
  const before = await page.evaluate(() => document.getElementById("list-range").textContent);
  await page.click("#records-body tr:nth-child(1) button[data-action=delete]");
  await page.waitForSelector(".confirm-row");
  await page.click(".confirm-row button[data-action=delete-confirm]");
  await page.waitForSelector("#action-note.is-ready, #action-note.is-error");
  const result = await page.evaluate(() => ({
    note: document.getElementById("action-note").textContent.replace(/\s+/g, " ").trim(),
    classes: document.getElementById("action-note").className,
    range: document.getElementById("list-range").textContent,
    gateHidden: document.getElementById("gate").hidden,
    panelVisible: !document.getElementById("panel").hidden
  }));
  console.log("before: " + before);
  console.log("after bad_csrf retry: " + JSON.stringify(result));
  console.log("page errors: " + (errors.length ? errors.join(", ") : "none"));
  await browser.close();
})();
