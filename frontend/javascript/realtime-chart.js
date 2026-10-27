/**
 * Realtime throughput chart, drawn like a terminal plot.
 *
 * The x axis is elapsed seconds, the y axis is Mbit/s, auto scaled to the
 * fastest sample of the run. Values are snapped to a 4 CSS pixel grid before
 * they are painted, so the trace comes out as chunky pixel steps rather than a
 * smooth curve.
 *
 * `frontend/javascript/index.js` drives it:
 *   RealtimeChart.begin()      - test started, clear and start plotting
 *   RealtimeChart.push(data)   - called on every speedtest update event
 *   RealtimeChart.end()        - test finished or aborted, freeze the plot
 *
 * The script is loaded from <head>, so the canvas is only looked up once the
 * DOM exists; the public API is registered immediately so the page script can
 * reference it at any point.
 */
(function () {
  "use strict";

  const PAD = { top: 12, right: 16, bottom: 26, left: 56 };
  const QUANT = 4; // px: the pixel grid the trace is snapped to
  const MIN_WINDOW = 10; // seconds on the x axis before the run outgrows it
  const SAMPLE_INTERVAL_MS = 90; // sampling rate fed into the series
  const FONT =
    '10px ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

  /* Used until the stylesheet is live, and if a variable ever goes missing.
     Keeping these valid matters: an invalid fillStyle is silently ignored and
     the canvas paints plain black. */
  const FALLBACK_COLORS = {
    dl: "rgba(107,161,245,0.95)",
    ul: "rgba(93,211,196,0.95)",
    grid: "rgba(93,211,196,0.14)",
    axis: "rgba(93,211,196,0.35)",
    label: "rgba(141,148,158,0.95)",
    standby: "rgba(141,148,158,0.8)",
  };

  let canvas = null;
  let ctx = null;
  let readout = null;
  let peakLabels = { dl: null, ul: null };
  let colors = FALLBACK_COLORS;
  let paletteReady = false;
  // The unit word is part of the readout, not of the drawing: see setUnit().
  let unitWord = "mbit/s";

  const series = { dl: [], ul: [] };
  let startedAt = 0;
  let running = false;
  let elapsed = 0;
  let lastSampleAt = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frameHandle = null;

  /* ---------------------------------------------------------------- helpers */

  function readPalette() {
    const rootStyle = getComputedStyle(document.documentElement);
    const triplet = (name) => {
      const value = rootStyle.getPropertyValue(name).trim();
      return /^\d+\s+\d+\s+\d+$/.test(value) ? value.replace(/\s+/g, ",") : null;
    };

    const accent = triplet("--crt-accent");
    const alt = triplet("--crt-alt");
    const muted = triplet("--crt-muted");
    if (!accent || !alt || !muted) return false;

    colors = {
      dl: `rgba(${accent},0.95)`,
      ul: `rgba(${alt},0.95)`,
      grid: `rgba(${alt},0.14)`,
      axis: `rgba(${alt},0.35)`,
      label: `rgba(${muted},0.95)`,
      standby: `rgba(${muted},0.8)`,
    };
    return true;
  }

  function niceCeiling(value) {
    if (!isFinite(value) || value <= 0) return 10;
    if (value <= 10) return 10;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const normalised = value / magnitude;
    const step =
      normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
    return step * magnitude;
  }

  function formatSpeed(value) {
    if (!isFinite(value) || value <= 0) return "0.0";
    return value < 10 ? value.toFixed(2) : value.toFixed(1);
  }

  function allValues() {
    return series.dl.concat(series.ul).map((sample) => sample.v);
  }

  function lastValue(list) {
    return list.length ? list[list.length - 1].v : 0;
  }

  function peakValue(list) {
    return list.length ? Math.max(...list.map((sample) => sample.v)) : 0;
  }

  /* Peaks are reported in the legend row rather than on the canvas: two labels
     near the same height used to collide, and the legend is where a reader
     looks for the numbers anyway. */
  function setPeakLabel(element, value) {
    if (!element) return;
    const text = value > 0 ? `max ${formatSpeed(value)}` : "";
    if (element.textContent !== text) element.textContent = text;
  }

  /* ------------------------------------------------------------- rendering */

  function dotLine(fromX, fromY, toX, toY) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const steps = Math.max(1, Math.round(Math.hypot(dx, dy) / (QUANT * 2)));
    for (let i = 0; i <= steps; i++) {
      const x = Math.round((fromX + (dx * i) / steps) / QUANT) * QUANT;
      const y = Math.round((fromY + (dy * i) / steps) / QUANT) * QUANT;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  function drawStandby() {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = FONT;
    ctx.fillStyle = colors.standby;
    ctx.fillText("awaiting test run", width / 2, height / 2);
  }

  function drawTrace(samples, stroke, xOf, yOf) {
    let previous = null;

    for (const sample of samples) {
      const x = Math.round(xOf(sample.t) / QUANT) * QUANT;
      const y = Math.round(yOf(sample.v) / QUANT) * QUANT;

      ctx.fillStyle = stroke;

      if (previous === null) {
        ctx.fillRect(x, y, QUANT, 3);
      } else {
        if (x > previous.x) {
          for (let px = previous.x; px < x; px += QUANT) {
            ctx.fillRect(px, previous.y, QUANT, 3);
          }
        }
        const top = Math.min(previous.y, y);
        const span = Math.abs(y - previous.y);
        if (span > 0) ctx.fillRect(x, top, 3, span + 3);
      }

      previous = { x: x, y: y };
    }

    if (!previous) return;

    // Highlight where the trace currently ends, and drop a dotted cursor.
    ctx.save();
    ctx.shadowColor = stroke;
    ctx.shadowBlur = 8;
    ctx.fillRect(previous.x, previous.y, QUANT, 3);
    ctx.restore();

    ctx.fillStyle = colors.axis;
    for (let y = PAD.top; y < height - PAD.bottom; y += QUANT * 2) {
      ctx.fillRect(previous.x, y, 1, 1);
    }
  }

  function draw() {
    if (!ctx || !width || !height) return;
    if (!paletteReady) paletteReady = readPalette();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const x0 = PAD.left;
    const x1 = width - PAD.right;
    const y0 = PAD.top;
    const y1 = height - PAD.bottom;
    if (x1 <= x0 + 20 || y1 <= y0 + 20) return;

    if (!series.dl.length && !series.ul.length && !running) {
      drawStandby();
      return;
    }

    const tMax = Math.max(MIN_WINDOW, elapsed);
    const vMax = niceCeiling(Math.max(10, ...allValues()));

    const xOf = (t) => x0 + (t / tMax) * (x1 - x0);
    const yOf = (v) => y1 - (Math.min(v, vMax) / vMax) * (y1 - y0);

    // Horizontal grid, four divisions, dotted to match the pixel look.
    ctx.fillStyle = colors.grid;
    for (let i = 0; i <= 4; i++) {
      dotLine(x0, yOf((vMax * i) / 4), x1, yOf((vMax * i) / 4));
    }

    // Vertical grid, roughly one line per two seconds.
    const secondStep = tMax > 30 ? 10 : tMax > 16 ? 5 : 2;
    for (let t = 0; t <= tMax + 0.001; t += secondStep) {
      dotLine(xOf(t), y0, xOf(t), y1);
    }

    // Axis labels
    ctx.font = FONT;
    ctx.fillStyle = colors.label;

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      if (i % 2 === 1 && vMax > 100) continue; // keep dense scales readable
      ctx.fillText(formatSpeed((vMax * i) / 4), x0 - 8, yOf((vMax * i) / 4));
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let t = 0; t <= tMax + 0.001; t += secondStep) {
      ctx.fillText(`${Math.round(t)}s`, xOf(t), y1 + 6);
    }

    // Axis rails
    ctx.fillStyle = colors.axis;
    for (let y = y0; y <= y1; y += QUANT) ctx.fillRect(x0, y, 1, 1);
    for (let x = x0; x <= x1; x += QUANT) ctx.fillRect(x, y1, 1, 1);

    // Peak markers: a dotted line at each series' own maximum, so the plot
    // reports the peak and not just the shape.
    ctx.font = FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    for (const series2 of [
      { list: series.dl, stroke: colors.dl },
      { list: series.ul, stroke: colors.ul },
    ]) {
      if (!series2.list.length) continue;
      const peak = Math.max(...series2.list.map((sample) => sample.v));
      if (peak <= 0) continue;

      const y = Math.round(yOf(peak) / QUANT) * QUANT;
      ctx.fillStyle = series2.stroke.replace(/[\d.]+\)$/, "0.35)");
      for (let x = x0; x <= x1; x += QUANT * 2) ctx.fillRect(x, y, 1, 1);
    }

    drawTrace(series.dl, colors.dl, xOf, yOf);
    drawTrace(series.ul, colors.ul, xOf, yOf);
  }

  function updateReadout() {
    setPeakLabel(peakLabels.dl, peakValue(series.dl));
    setPeakLabel(peakLabels.ul, peakValue(series.ul));

    if (!readout) return;
    if (!running && !series.dl.length && !series.ul.length) {
      readout.textContent = "standby";
      return;
    }
    readout.textContent =
      `t+${elapsed.toFixed(1)}s  ` +
      `dl ${formatSpeed(lastValue(series.dl))}  ` +
      `ul ${formatSpeed(lastValue(series.ul))} ${unitWord}`;
  }

  /* ------------------------------------------------------------------ loop */

  function tick(timestamp) {
    frameHandle = requestAnimationFrame(tick);
    elapsed = (timestamp - startedAt) / 1000;
    draw();
    updateReadout();
  }

  function startLoop() {
    if (frameHandle === null) frameHandle = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!w || !h) return;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = w;
    height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    draw();
  }

  /* ------------------------------------------------------------- public API */

  window.RealtimeChart = {
    /**
     * The axis label follows the unit the measurement is reported in, so a
     * Mibit/s run never leaves "mbit/s" sitting next to the numbers.
     */
    setUnit: function (word) {
      unitWord = word || "mbit/s";
      updateReadout();
    },

    begin: function () {
      series.dl = [];
      series.ul = [];
      startedAt = performance.now();
      lastSampleAt = 0;
      elapsed = 0;
      running = true;
      resize();
      draw();
      updateReadout();
      startLoop();
    },

    push: function (data) {
      if (!running || !data) return;

      const now = performance.now();
      if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
      lastSampleAt = now;

      const t = (now - startedAt) / 1000;
      const state = Number(data.testState);

      if (state === 1) {
        series.dl.push({ t: t, v: Number(data.dlStatus) || 0 });
      } else if (state === 3) {
        series.ul.push({ t: t, v: Number(data.ulStatus) || 0 });
      }
    },

    end: function () {
      if (!running) return;
      elapsed = (performance.now() - startedAt) / 1000;
      running = false;
      stopLoop();
      draw();
      updateReadout();
    },

    reset: function () {
      stopLoop();
      series.dl = [];
      series.ul = [];
      elapsed = 0;
      running = false;
      draw();
      updateReadout();
    },
  };

  function init() {
    canvas = document.getElementById("realtime-chart");
    if (!canvas || !canvas.getContext) return;

    ctx = canvas.getContext("2d");
    readout = document.getElementById("chart-readout");
    peakLabels = {
      dl: document.getElementById("peak-download"),
      ul: document.getElementById("peak-upload"),
    };
    paletteReady = readPalette();
    resize();

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(resize).observe(canvas);
    } else {
      window.addEventListener("resize", resize);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
