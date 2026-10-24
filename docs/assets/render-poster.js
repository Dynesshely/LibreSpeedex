/**
 * Render docs/assets/poster.html to docs/assets/poster.jpg.
 *
 *   node docs/assets/render-poster.js
 *
 * Chromium draws at 2x, then the capture is stepped down to the poster's own
 * size and encoded as JPEG (the scanlines hide any banding the codec adds, and
 * the PNG of the same image is four times the size): text set at 2x and resampled is noticeably cleaner than text set at the
 * final size, and the poster is the one image people look at first.
 *
 * Playwright is a devDependency of this repository, so this needs `npm install`
 * (it is not needed to run or build the site).
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const HERE = __dirname;
const SOURCE = path.join(HERE, "poster.html");
const TARGET = path.join(HERE, "poster.jpg");
const WIDTH = 1600;
const HEIGHT = 720;
const SCALE = 2;

// The bundled Chromium is the one the pages are verified in; allow an override
// for machines where the browser lives in a different cache directory.
const EXEC = process.env.CHROMIUM_PATH || undefined;

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : { args: ["--no-sandbox"] });
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
  });

  await page.goto("file://" + SOURCE, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);

  const big = await page.screenshot({ type: "png" });
  await browser.close();

  // Step down to the poster's own pixel size, in the page itself, so no image
  // library has to be installed for this.
  const resized = await (async () => {
    const b = await chromium.launch(EXEC ? { executablePath: EXEC } : { args: ["--no-sandbox"] });
    const p = await b.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    const data = await p.evaluate(
      async ({ base64, width, height }) => {
        const image = new Image();
        image.src = "data:image/png;base64," + base64;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, width, height);
        return canvas.toDataURL("image/jpeg", 0.92);
      },
      { base64: big.toString("base64"), width: WIDTH, height: HEIGHT }
    );
    await b.close();
    return Buffer.from(data.split(",")[1], "base64");
  })();

  fs.writeFileSync(TARGET, resized);
  console.log(`poster.jpg ${WIDTH}x${HEIGHT} — ${(resized.length / 1024).toFixed(0)} kB`);
})().catch((error) => {
  console.error("poster render failed:", error);
  process.exit(1);
});
