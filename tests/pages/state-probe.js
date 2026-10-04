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
  await page.goto("http://127.0.0.1:18210/results/admin.html");
  await page.waitForSelector("#login-form:not([hidden])");
  await page.fill("#password", "librespeed");
  await page.click("#login-submit");
  await page.waitForSelector("#records-body tr");
  await context.clearCookies();
  await page.click("#page-next");
  await page.waitForSelector("#login-form:not([hidden])");
  const gate = await page.evaluate(() => ({
    note: document.getElementById("gate-note").textContent.replace(/\s+/g, " ").trim(),
    classes: document.getElementById("gate-note").className,
    visible: !document.getElementById("gate-note").hidden,
    form: !document.getElementById("login-form").hidden,
    header: document.getElementById("header-status").textContent
  }));
  console.log("401 fallback: " + JSON.stringify(gate));
  await page.locator("#gate").screenshot({ path: path.join(__dirname, "admin-unauthorized-gate-1300.png") });
  await browser.close();
})();
