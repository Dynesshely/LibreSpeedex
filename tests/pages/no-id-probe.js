/**
 * Evidence for one rule: with no client id in localStorage the page must not
 * call the endpoint at all. Counts the requests the page makes.
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
  const calls = [];
  page.on("request", request => {
    if (request.url().indexOf("mine.php") !== -1) calls.push(request.url());
  });
  await page.goto("http://127.0.0.1:18210/my-results.html");
  await page.waitForSelector("#state:not([hidden])");
  await page.waitForTimeout(600);
  console.log("mine.php calls with no local id: " + calls.length + (calls.length ? " -> " + calls.join(", ") : ""));

  /* and with a rate limited id, where the page must say so instead of retrying */
  const limited = await context.newPage();
  let limitedCalls = 0;
  limited.on("request", request => {
    if (request.url().indexOf("mine.php") !== -1) limitedCalls += 1;
  });
  await limited.addInitScript(() => window.localStorage.setItem("librespeedex.clientId", "rate-limited"));
  await limited.goto("http://127.0.0.1:18210/my-results.html");
  await limited.waitForFunction(() => document.getElementById("header-status").textContent === "rate limited");
  await limited.waitForTimeout(800);
  console.log("mine.php calls for a rate limited id: " + limitedCalls + " (must stay 1: no automatic retry loop)");
  await browser.close();
})();
