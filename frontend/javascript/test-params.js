/**
 * Measurement parameters: the dials behind a single test run.
 *
 * The engine has always accepted a full settings object (`start {…}` in
 * speedtest_worker.js overrides anything it recognises), it simply never had a
 * face. This module is that face: it owns the small set of parameters a
 * visitor may reasonably change, renders them as one collapsible console block,
 * and remembers the choice in both the URL and localStorage so a run can be
 * repeated or shared.
 *
 * Two rules shape what is exposed here:
 *
 *   1. Nothing that changes *where* the traffic goes. url_dl / url_ul /
 *      url_ping are not dials, they are the place the traffic lands; letting a
 *      visitor retarget them turns the server into a reflector.
 *   2. Nothing that silently breaks comparability. Every exposed parameter is
 *      recorded in the snapshot stored alongside the result, so a stored number
 *      can always be read back in context.
 *
 * Values are kept in the engine's own types (numbers stay numbers, booleans
 * stay booleans) because `useMebibits: "false"` would be truthy in the worker.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "librespeedex.measurement";
  const CLIENT_ID_KEY = "librespeedex.clientId";

  /** Fallback defaults, used when settings.json could not be read. Mirrors the top of speedtest_worker.js. */
  const ENGINE_DEFAULTS = {
    time_dl_max: 15,
    time_ul_max: 15,
    count_ping: 10,
    time_auto: true,
    time_dlGraceTime: 1.5,
    time_ulGraceTime: 3,
    xhr_dlMultistream: 6,
    xhr_ulMultistream: 3,
    xhr_multistreamDelay: 300,
    xhr_dlUseBlob: false,
    garbagePhp_chunkSize: 100,
    ping_allowPerformanceApi: true,
    overheadCompensationFactor: 1.06,
    useMebibits: false,
    telemetry_level: 0,
  };

  const numberOptions = (values) => values.map((v) => ({ value: v, label: String(v) }));

  /**
   * The exposed dials. `group` decides whether a control sits in the open panel
   * or behind the advanced fold; `telemetry_level` is special-cased because it
   * is already stored as a word in settings.json.
   */
  const SPECS = [
    {
      key: "time_dl_max",
      label: "download time",
      suffix: "s",
      group: "basic",
      type: "number",
      options: numberOptions([5, 10, 15, 20, 30, 60]),
      hint: "How long the download phase is allowed to run.",
    },
    {
      key: "time_ul_max",
      label: "upload time",
      suffix: "s",
      group: "basic",
      type: "number",
      options: numberOptions([5, 10, 15, 20, 30, 60]),
      hint: "How long the upload phase is allowed to run.",
    },
    {
      key: "count_ping",
      label: "ping samples",
      group: "basic",
      type: "number",
      options: numberOptions([5, 10, 20, 50]),
      hint: "Latency is reported as the best of these samples.",
    },
    {
      key: "xhr_dlMultistream",
      label: "download streams",
      group: "basic",
      type: "number",
      options: numberOptions([1, 2, 3, 6, 12]),
      hint: "One stream measures a single connection; several measure the whole link.",
    },
    {
      key: "xhr_ulMultistream",
      label: "upload streams",
      group: "basic",
      type: "number",
      options: numberOptions([1, 2, 3, 6]),
      hint: "As above, for the upload direction.",
    },
    {
      key: "useMebibits",
      label: "unit",
      group: "basic",
      type: "boolean",
      options: [
        { value: false, label: "Mbit/s (1000²)" },
        { value: true, label: "Mibit/s (1024²)" },
      ],
      hint: "The 1000/1024 question, stated instead of assumed.",
    },
    {
      key: "overheadCompensationFactor",
      label: "reporting",
      group: "basic",
      type: "number",
      options: [
        { value: 1, label: "payload only (×1.0)" },
        { value: 1.0369, label: "+ IPv4/TCP/HTTP (×1.0369)" },
        { value: 1.0513, label: "+ IPv6/TCP/HTTP (×1.0513)" },
        { value: 1.06, label: "standard (×1.06)" },
        { value: 1.081, label: "high estimate (×1.081)" },
      ],
      hint: "Adds the transport overhead back on top of the measured payload rate.",
    },
    {
      key: "time_auto",
      label: "shorten on fast links",
      group: "basic",
      type: "boolean",
      options: [
        { value: true, label: "on" },
        { value: false, label: "off" },
      ],
      hint: "On, a fast link finishes early; off, the full window is always measured.",
    },
    {
      key: "garbagePhp_chunkSize",
      label: "download block",
      suffix: "MB",
      group: "advanced",
      type: "number",
      options: numberOptions([25, 50, 100, 256]),
      hint: "Megabytes requested per stream. Bounded by the server's own cap.",
    },
    {
      key: "time_dlGraceTime",
      label: "download warmup",
      suffix: "s",
      group: "advanced",
      type: "number",
      options: numberOptions([0, 0.5, 1.5, 3]),
      hint: "Samples taken before this are discarded, while the TCP window grows.",
    },
    {
      key: "time_ulGraceTime",
      label: "upload warmup",
      suffix: "s",
      group: "advanced",
      type: "number",
      options: numberOptions([0, 1, 3, 5]),
      hint: "Discarded while the send buffers fill. Too short inflates the result.",
    },
    {
      key: "xhr_multistreamDelay",
      label: "stream stagger",
      suffix: "ms",
      group: "advanced",
      type: "number",
      options: numberOptions([0, 150, 300, 600]),
      hint: "Delay between starting streams, so they do not all finish together.",
    },
    {
      key: "xhr_dlUseBlob",
      label: "stream to disk",
      group: "advanced",
      type: "boolean",
      options: [
        { value: false, label: "off (memory)" },
        { value: true, label: "on (disk)" },
      ],
      hint: "Trades RAM for disk writes on very fast links.",
    },
    {
      key: "ping_allowPerformanceApi",
      label: "precise ping",
      group: "advanced",
      type: "boolean",
      options: [
        { value: true, label: "on" },
        { value: false, label: "off" },
      ],
      hint: "Uses the browser's own request timing instead of the clock estimate.",
    },
    {
      key: "telemetry_level",
      label: "save this result",
      group: "advanced",
      type: "boolean",
      options: [
        { value: true, label: "on" },
        { value: false, label: "off" },
      ],
      hint: "Off means this run is never written to the server's database.",
      wordy: true,
    },
  ];

  const PRESETS = [
    {
      id: "standard",
      label: "standard",
      hint: "This server's own defaults",
      values: {},
    },
    {
      id: "quick",
      label: "quick",
      hint: "Five seconds each way",
      values: {
        time_dl_max: 5,
        time_ul_max: 5,
        count_ping: 5,
        time_auto: true,
        time_dlGraceTime: 0,
        time_ulGraceTime: 1,
      },
    },
    {
      id: "strict",
      label: "strict",
      hint: "Long window, no early finish",
      values: {
        time_dl_max: 30,
        time_ul_max: 30,
        count_ping: 20,
        time_auto: false,
        time_dlGraceTime: 1.5,
        time_ulGraceTime: 3,
      },
    },
    {
      id: "single",
      label: "single connection",
      hint: "What one download actually feels like",
      values: { xhr_dlMultistream: 1, xhr_ulMultistream: 1, time_auto: false },
    },
  ];

  const state = {
    base: Object.assign({}, ENGINE_DEFAULTS),
    overrides: {},
    preset: "standard",
    telemetryAvailable: false,
    listeners: [],
    nodes: null,
    memoryClientId: "",
  };

  /* ------------------------------------------------------------------ value */

  function spec(key) {
    return SPECS.filter((s) => s.key === key)[0];
  }

  /** Coerce a value that came from a URL or storage back to the engine's type. */
  function coerce(key, value) {
    const definition = spec(key);
    if (!definition) return undefined;
    // telemetry_level is stored as a word in settings.json, so keep whatever
    // vocabulary the server used rather than inventing a second one.
    if (definition.wordy) {
      if (typeof value === "boolean") return value ? "basic" : "off";
      const text = String(value).toLowerCase();
      if (text === "off" || text === "disabled" || text === "false" || text === "0") return "off";
      return text === "1" ? "basic" : text;
    }
    if (definition.type === "boolean") {
      if (typeof value === "boolean") return value;
      const text = String(value).toLowerCase();
      return text === "1" || text === "true" || text === "on" || text === "yes";
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  function value(key) {
    if (Object.prototype.hasOwnProperty.call(state.overrides, key)) {
      return state.overrides[key];
    }
    if (Object.prototype.hasOwnProperty.call(state.base, key)) {
      return state.base[key];
    }
    return ENGINE_DEFAULTS[key];
  }

  /** Read a toggle as a boolean regardless of which vocabulary the server used. */
  function isOn(key) {
    const v = value(key);
    if (typeof v === "boolean") return v;
    const text = String(v).toLowerCase();
    return !(text === "off" || text === "disabled" || text === "false" || text === "0");
  }

  /* ------------------------------------------------------------ url + store */

  function encodeOverrides() {
    const pairs = [];
    for (const definition of SPECS) {
      if (!Object.prototype.hasOwnProperty.call(state.overrides, definition.key)) continue;
      if (definition.wordy) {
        pairs.push(definition.key + ":" + (isOn(definition.key) ? "on" : "off"));
        continue;
      }
      const v = state.overrides[definition.key];
      pairs.push(definition.key + ":" + (typeof v === "boolean" ? (v ? 1 : 0) : v));
    }
    return pairs.join(",");
  }

  function decodeOverrides(text) {
    const out = {};
    if (!text) return out;
    text.split(",").forEach((pair) => {
      const at = pair.indexOf(":");
      if (at < 1) return;
      const key = pair.slice(0, at).trim();
      const definition = spec(key);
      if (!definition) return; // unknown or removed dial: ignored, never guessed at
      const coerced = coerce(key, pair.slice(at + 1).trim());
      if (coerced !== undefined) out[key] = coerced;
    });
    return out;
  }

  function readFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      return decodeOverrides(params.get("p"));
    } catch (error) {
      return {};
    }
  }

  function readFromStorage() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function persist() {
    // The URL is the shareable half, so it is always rewritten; storage is the
    // convenience half, and losing it (private mode, cleared data) must not
    // break the page.
    try {
      const url = new URL(window.location.href);
      const encoded = encodeOverrides();
      if (encoded) url.searchParams.set("p", encoded);
      else url.searchParams.delete("p");
      url.hash = window.location.hash;
      window.history.replaceState({}, "", url.toString());
    } catch (error) {
      /* file:// or a locked-down history API: the panel still works */
    }
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ preset: state.preset, overrides: state.overrides })
      );
    } catch (error) {
      /* storage unavailable: the choice simply does not survive a reload */
    }
  }

  /* --------------------------------------------------------------- identity */

  /**
   * An anonymous, browser-local identifier. Records are grouped by this instead
   * of by IP address, because an address is shared by everyone behind one NAT
   * and would show a visitor other people's tests.
   */
  function randomId() {
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (error) {
      /* fall through to the weak path below */
    }
    let out = "";
    for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }

  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

  function clientId() {
    try {
      const stored = window.localStorage.getItem(CLIENT_ID_KEY);
      if (stored && ID_PATTERN.test(stored)) return stored;
      const fresh = randomId();
      window.localStorage.setItem(CLIENT_ID_KEY, fresh);
      return fresh;
    } catch (error) {
      if (!state.memoryClientId) state.memoryClientId = randomId();
      return state.memoryClientId;
    }
  }

  function forgetClientId() {
    try {
      window.localStorage.removeItem(CLIENT_ID_KEY);
    } catch (error) {
      /* nothing to forget */
    }
    state.memoryClientId = "";
  }

  /* ------------------------------------------------------------- the engine */

  function snapshotObject() {
    const out = { v: 1, preset: state.preset };
    for (const definition of SPECS) {
      out[definition.key] = definition.wordy ? (isOn(definition.key) ? "basic" : "off") : value(definition.key);
    }
    return out;
  }

  /** Push the effective values into a Speedtest instance, just before start(). */
  function applyTo(speedtest) {
    if (!speedtest) return;
    const values = snapshotObject();
    for (const definition of SPECS) {
      try {
        speedtest.setParameter(definition.key, values[definition.key]);
      } catch (error) {
        /* the engine rejects settings mid-run; the next run picks them up */
      }
    }
    try {
      speedtest.setParameter("client_id", clientId());
      speedtest.setParameter("params_snapshot", JSON.stringify(values));
    } catch (error) {
      /* as above */
    }
  }

  /* ------------------------------------------------------------------- view */

  function summaryText() {
    const dl = value("time_dl_max");
    const ul = value("time_ul_max");
    const streams = value("xhr_dlMultistream") + "+" + value("xhr_ulMultistream");
    const unit = value("useMebibits") ? "Mibit/s" : "Mbit/s";
    const parts = [
      dl + "s/" + ul + "s",
      streams + " streams",
      unit,
      value("count_ping") + " pings",
    ];
    if (!isOn("time_auto")) parts.push("full window");
    parts.push(state.preset === "standard" ? "standard" : state.preset + " preset");
    return parts.join("  ·  ");
  }

  function renderReadout() {
    if (!state.nodes) return;
    state.nodes.readout.textContent = summaryText();
    state.nodes.body.querySelectorAll("[data-param]").forEach((control) => {
      ensureOption(control, spec(control.dataset.param));
    });
    if (state.nodes.telemetryToggle) {
      state.nodes.telemetryToggle.closest(".param").hidden = !state.telemetryAvailable;
    }
    state.nodes.presetButtons.forEach((button) => {
      const active = button.dataset.preset === state.preset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    // Keep the gauge unit honest: the number and its unit are one claim.
    const unitText = value("useMebibits") ? "Mibit/s" : "Mbps";
    document.querySelectorAll("[data-unit]").forEach((node) => {
      node.textContent = unitText;
    });
    const legendUnit = value("useMebibits") ? "mibit/s" : "mbit/s";
    document.querySelectorAll("[data-unit-legend]").forEach((node) => {
      node.textContent = legendUnit;
    });
    if (window.RealtimeChart && window.RealtimeChart.setUnit) {
      window.RealtimeChart.setUnit(legendUnit);
    }
  }

  /**
   * Show the current value, adding a step for it when the server's default is
   * not one of the offered ones.
   *
   * This has to happen on every render, not just when the control is built:
   * settings.json arrives after the panel is built, so a server default of 12
   * seconds would otherwise leave the select blank.
   */
  function ensureOption(select, definition) {
    if (!definition) return;
    if (definition.wordy) {
      select.value = isOn(definition.key) ? "on" : "off";
      return;
    }
    const wanted = String(value(definition.key));
    const present = Array.prototype.some.call(select.options, (o) => o.value === wanted);
    if (!present) {
      const node = document.createElement("option");
      node.value = wanted;
      node.textContent = wanted;
      const after = Array.prototype.find.call(
        select.options,
        (o) => Number(o.value) > Number(wanted)
      );
      select.insertBefore(node, after || null);
    }
    select.value = wanted;
  }

  function buildControl(definition) {
    const label = document.createElement("label");
    label.className = "param";

    const name = document.createElement("span");
    name.className = "param-name";
    name.textContent = definition.label;
    if (definition.suffix) {
      const suffix = document.createElement("i");
      suffix.className = "param-suffix";
      suffix.textContent = "(" + definition.suffix + ")";
      name.appendChild(suffix);
    }
    label.appendChild(name);

    const select = document.createElement("select");
    select.dataset.param = definition.key;
    select.id = "param-" + definition.key;

    (definition.wordy
      ? [{ value: "on", label: "on" }, { value: "off", label: "off" }]
      : definition.options
    ).forEach((option) => {
      const node = document.createElement("option");
      node.value = String(option.value);
      node.textContent = option.label;
      select.appendChild(node);
    });
    ensureOption(select, definition);

    select.addEventListener("change", () => {
      const parsed = definition.wordy
        ? select.value
        : coerce(definition.key, select.value);
      if (parsed === undefined) return;
      state.overrides[definition.key] = parsed;
      state.preset = "custom";
      persist();
      renderReadout();
      notify();
    });

    label.appendChild(select);

    if (definition.hint) {
      const hint = document.createElement("span");
      hint.className = "param-hint";
      hint.textContent = definition.hint;
      label.appendChild(hint);
    }

    return { label, select };
  }

  function buildPanel(root) {
    const toggle = root.querySelector("#params-toggle");
    const body = root.querySelector("#params-body");
    const readout = root.querySelector("#params-readout");
    const presetsRow = root.querySelector("#params-presets");
    const basicGrid = root.querySelector("#params-basic");
    const advancedGrid = root.querySelector("#params-advanced");
    const resetButton = root.querySelector("#params-reset");
    const shareButton = root.querySelector("#params-share");
    const shareNote = root.querySelector("#params-note");

    toggle.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      root.classList.toggle("open", open);
    });

    const presetButtons = [];
    PRESETS.forEach((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "param-preset";
      button.dataset.preset = preset.id;
      button.title = preset.hint;
      button.textContent = preset.label;
      button.addEventListener("click", () => {
        state.overrides = Object.assign({}, preset.values);
        state.preset = preset.id;
        persist();
        renderReadout();
        notify();
      });
      presetsRow.appendChild(button);
      presetButtons.push(button);
    });

    let telemetryToggle = null;
    SPECS.forEach((definition) => {
      const { label, select } = buildControl(definition);
      (definition.group === "advanced" ? advancedGrid : basicGrid).appendChild(label);
      if (definition.key === "telemetry_level") telemetryToggle = select;
    });

    resetButton.addEventListener("click", () => {
      state.overrides = {};
      state.preset = "standard";
      persist();
      renderReadout();
      notify();
    });

    shareButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        shareNote.textContent = "link copied — it carries these parameters";
      } catch (error) {
        shareNote.textContent = "copy failed; the address bar already carries them";
      }
      window.setTimeout(() => {
        shareNote.textContent = "";
      }, 4000);
    });

    state.nodes = {
      root,
      toggle,
      body,
      readout,
      presetButtons,
      telemetryToggle,
    };
  }

  function notify() {
    state.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    });
  }

  /* ------------------------------------------------------------------- api */

  const TestParams = {
    /** Called with the parsed settings.json so server defaults become the base. */
    setBase(settings) {
      if (!settings || typeof settings !== "object") return;
      for (const key of Object.keys(ENGINE_DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
          const coerced = coerce(key, settings[key]);
          if (coerced !== undefined) state.base[key] = coerced;
        }
      }
      state.telemetryAvailable = isOn("telemetry_level");
      renderReadout();
    },

    /** Load the stored / linked choice. Must run before the first render. */
    init() {
      const fromUrl = readFromUrl();
      const stored = readFromStorage();
      // The URL wins: a shared link is an explicit instruction, storage is only
      // what this browser happened to do last time.
      if (Object.keys(fromUrl).length > 0) {
        state.overrides = fromUrl;
        state.preset = "custom";
      } else if (stored && stored.overrides) {
        const decoded = {};
        Object.keys(stored.overrides).forEach((key) => {
          const coerced = coerce(key, stored.overrides[key]);
          if (coerced !== undefined) decoded[key] = coerced;
        });
        state.overrides = decoded;
        state.preset = stored.preset || "standard";
      }
      const root = document.querySelector("#params-panel");
      if (root) buildPanel(root);
      renderReadout();
      return state.overrides;
    },

    mount() {
      const root = document.querySelector("#params-panel");
      if (root && !state.nodes) buildPanel(root);
      renderReadout();
    },

    applyTo,
    clientId,
    forgetClientId,
    snapshot: () => JSON.stringify(snapshotObject()),
    value,
    isOn,
    summary: summaryText,
    preset: () => state.preset,
    onChange(listener) {
      state.listeners.push(listener);
    },
    /** Used by the results page, which only needs the identity half. */
    storageKeys: { measurement: STORAGE_KEY, clientId: CLIENT_ID_KEY },
  };

  window.TestParams = TestParams;
})();
