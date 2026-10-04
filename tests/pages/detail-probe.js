"use strict";
const { chromium } = require("playwright");
const path = require("path");
const HEADLESS_SHELL =
  process.env.CHROMIUM_PATH ||
  path.join(
    process.env.HOME,
    ".cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
  );
(async function () {
  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL });
  const context = await browser.newContext({ viewport: { width: 1300, height: 950 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:18210/results/admin.html");
  await page.waitForSelector("#login-form:not([hidden])");
  await page.fill("#password", "librespeed");
  await page.click("#login-submit");
  await page.waitForSelector("#records-body tr");
  await page.click("#records-body tr:nth-child(2) button[data-action=detail]");
  await page.waitForFunction(() => document.getElementById("detail-log").textContent.length > 10);
  await page.locator("#detail").screenshot({ path: path.join(__dirname, "admin-detail-2x.png") });
  const metrics = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll("#detail-fields .param"))
      .slice(0, 6)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return { t: Math.round(rect.top), h: Math.round(rect.height) };
      });
    const fields = document.getElementById("detail-fields");
    return {
      boxes,
      cols: getComputedStyle(fields).gridTemplateColumns,
      fieldsH: Math.round(fields.getBoundingClientRect().height)
    };
  });
  console.log(JSON.stringify(metrics));
  await browser.close();
})();
