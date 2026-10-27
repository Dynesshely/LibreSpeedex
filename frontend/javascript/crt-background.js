/**
 * Pixelated terminal backdrop.
 *
 * Draws on a low resolution canvas that the browser scales up with
 * `image-rendering: pixelated`, so every canvas pixel is a chunky 4 CSS pixel
 * block. On top of the dim activity grid the screen gets:
 *
 *   - random cells lighting up, like memory traffic
 *   - a few slow vertical data streams
 *   - the occasional horizontal packet dash
 *
 * Rendering is capped at ~12 fps and pauses while the tab is hidden, so it
 * costs next to nothing. With `prefers-reduced-motion` a single static frame is
 * drawn instead.
 *
 * The script is loaded from <head>, so the canvas is looked up once the DOM
 * exists.
 */
(function () {
  "use strict";

  const PIXEL = 4; // CSS pixels per canvas pixel
  const GRID = 16; // grid pitch, in canvas pixels
  const FPS = 12;
  const STREAM_FADE = 0.5;
  const DASH_LENGTH = 26;

  /* Fallbacks in case the stylesheet has not been applied yet; readPalette()
     below refreshes them from colors.css once the DOM is live, so the palette
     stays defined in exactly one place. */
  let PHOSPHOR = "107,161,245";
  let ALT = "93,211,196";

  function readPalette() {
    const rootStyle = getComputedStyle(document.documentElement);
    const triplet = (name, fallback) => {
      const value = rootStyle.getPropertyValue(name).trim();
      return /^\d+\s+\d+\s+\d+$/.test(value)
        ? value.replace(/\s+/g, ",")
        : fallback;
    };
    PHOSPHOR = triplet("--crt-accent", PHOSPHOR);
    ALT = triplet("--crt-alt", ALT);
  }

  let canvas = null;
  let ctx = null;
  let reducedMotion = false;

  let cols = 0;
  let rows = 0;
  let grid = null;
  let streams = [];
  let dashes = [];
  let lastFrame = 0;
  let frameHandle = null;

  /* How busy the link is right now, 0..1, and which direction is being
     measured. The page script feeds this in, so the backdrop stops being a
     looping wallpaper and becomes a readout of the test itself. */
  let energy = 0;
  let hue = null; /* null = idle, otherwise the active direction's triplet */

  function buildGrid() {
    grid = document.createElement("canvas");
    grid.width = cols;
    grid.height = rows;

    const g = grid.getContext("2d");
    g.fillStyle = `rgba(${PHOSPHOR},0.05)`;
    for (let y = 0; y < rows; y += GRID) {
      for (let x = 0; x < cols; x += GRID) {
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  function seed() {
    streams = [];
    const streamCount = Math.max(3, Math.round(cols / 44));
    for (let i = 0; i < streamCount; i++) {
      streams.push({
        x: Math.floor(Math.random() * cols),
        y: Math.random() * -rows,
        length: 5 + Math.floor(Math.random() * 20),
        speed: 0.25 + Math.random() * 0.75,
        alt: Math.random() < 0.25,
      });
    }

    dashes = [];
    for (let i = 0; i < 2; i++) {
      dashes.push({
        x: -Math.floor(Math.random() * 60),
        y: Math.floor(Math.random() * rows),
        speed: 1 + Math.random() * 2.2,
      });
    }
  }

  function resize() {
    if (!canvas) return false;

    const w = Math.max(1, Math.ceil(window.innerWidth / PIXEL));
    const h = Math.max(1, Math.ceil(window.innerHeight / PIXEL));
    if (w === cols && h === rows) return false;

    cols = w;
    rows = h;
    canvas.width = cols;
    canvas.height = rows;
    buildGrid();
    seed();
    return true;
  }

  function drawActivity() {
    // Sparse random cells, so the grid looks alive rather than uniform. Both
    // the count and the brightness grow with the link load.
    const count = Math.max(
      6,
      Math.round(((cols * rows) / 900) * (1 + energy * 2.1))
    );
    const colour = hue || PHOSPHOR;
    for (let i = 0; i < count; i++) {
      const x = Math.floor(Math.random() * cols);
      const y = Math.floor(Math.random() * rows);
      const alpha = (0.06 + Math.random() * 0.2) * (1 + energy);
      ctx.fillStyle = `rgba(${colour},${Math.min(alpha, 0.5)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  function drawStreams() {
    const speedScale = 0.7 + energy * 2.2;
    for (const s of streams) {
      s.y += s.speed * speedScale;
      if (s.y - s.length > rows) {
        s.y = -Math.random() * rows * 0.4;
        s.x = Math.floor(Math.random() * cols);
      }
      // While a direction is being measured every stream carries that
      // direction's colour. Idle stays monochrome: in this palette colour means
      // "this is being measured", so an idle screen should have none.
      const colour = hue || PHOSPHOR;
      const fade = STREAM_FADE * (1 + energy * 0.8);
      for (let i = 0; i < s.length; i++) {
        const y = Math.floor(s.y) - i;
        if (y < 0 || y >= rows) continue;
        ctx.fillStyle = `rgba(${colour},${Math.min(
          (1 - i / s.length) * fade,
          0.9
        )})`;
        ctx.fillRect(s.x, y, 1, 1);
      }
    }
  }

  function drawDashes() {
    const colour = hue || PHOSPHOR;
    const speedScale = 1 + energy * 2.2;
    for (const d of dashes) {
      d.x += d.speed * speedScale;
      if (d.x - DASH_LENGTH > cols) {
        // Packet dashes only really show up once there is traffic.
        if (Math.random() > 0.3 + energy * 0.7) continue;
        d.x = -Math.floor(Math.random() * 60);
        d.y = Math.floor(Math.random() * rows);
      }
      for (let i = 0; i < DASH_LENGTH; i++) {
        const x = Math.floor(d.x) - i;
        if (x < 0 || x >= cols) continue;
        ctx.fillStyle = `rgba(${colour},${Math.min(
          (1 - i / DASH_LENGTH) * 0.4 * (0.6 + energy),
          0.8
        )})`;
        ctx.fillRect(x, d.y, 1, 1);
      }
    }
  }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cols, rows);
    if (grid) ctx.drawImage(grid, 0, 0);
    drawActivity();
    drawStreams();
    drawDashes();
  }

  function loop(timestamp) {
    frameHandle = requestAnimationFrame(loop);
    if (timestamp - lastFrame < 1000 / FPS) return;
    lastFrame = timestamp;
    render();
  }

  function start() {
    if (frameHandle === null) frameHandle = requestAnimationFrame(loop);
  }

  function stop() {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
  }

  /* ------------------------------------------------------------- public API */

  /* Set from frontend/javascript/index.js while a test runs:
     level is 0..1 (log-scaled speed) and direction is "download" | "upload". */
  window.CrtBackground = {
    setActivity: function (level, direction) {
      const nextEnergy = Math.max(0, Math.min(1, Number(level) || 0));
      const nextHue =
        direction === "download"
          ? ALT
          : direction === "upload"
            ? PHOSPHOR
            : null;

      // Called every frame, so only repaint on a visible change.
      const changed =
        Math.abs(nextEnergy - energy) > 0.02 || nextHue !== hue;

      energy = nextEnergy;
      hue = nextHue;

      if (reducedMotion && changed) render();
    },
  };

  function init() {
    canvas = document.getElementById("crt-pixels");
    if (!canvas || !canvas.getContext) return;

    ctx = canvas.getContext("2d");
    if (!ctx) return;

    readPalette();

    reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    resize();
    render();

    if (reducedMotion) return;

    start();

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    });

    window.addEventListener("resize", () => {
      if (resize()) render();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
