/**
 * Design by fromScratch Studio - 2022, 2023 (fromscratch.io)
 * Implementation in HTML/CSS/JS by Timendus - 2024 (https://github.com/Timendus)
 *
 * See https://github.com/librespeed/speedtest/issues/585
 */

/* global Speedtest -- the engine, loaded from speedtest.js before this file */

// States the UI can be in
const INITIALIZING = 0;
const READY = 1;
const RUNNING = 2;
const FINISHED = 3;

// Keep some global state here
const testState = {
  state: INITIALIZING,
  speedtest: null,
  servers: [],
  initialGaugeScrollPending: false,
  initialGaugeScrollScheduled: false,
  selectedServerDirty: false,
  testData: null,
  testDataDirty: false,
  telemetryEnabled: false,
};

// Bootstrap the application when the DOM is ready
window.addEventListener("DOMContentLoaded", async () => {
  createSpeedtest();
  hookUpButtons();
  startRenderingLoop();
  // The panel has to exist before settings.json lands: the server defaults
  // become its base, and a visitor's stored choice is layered on top of that.
  if (window.TestParams) window.TestParams.init();
  applySettingsJSON();
  applyServerListJSON();
});

/**
 * Create a new Speedtest and hook it into the global state
 */
function createSpeedtest() {
  testState.speedtest = new Speedtest();
  testState.speedtest.onupdate = (data) => {
    testState.testData = data;
    testState.testDataDirty = true;
    // Feed the realtime plot (frontend/javascript/realtime-chart.js)
    if (window.RealtimeChart) window.RealtimeChart.push(data);
  };
  testState.speedtest.onend = (aborted) => {
    testState.state = aborted ? READY : FINISHED;
    if (window.RealtimeChart) window.RealtimeChart.end();
  };
}

/**
 * Make all the buttons respond to the right clicks
 */
function hookUpButtons() {
  document
    .querySelector("#start-button")
    .addEventListener("click", startButtonClickHandler);
  document
    .querySelector("#choose-privacy")
    .addEventListener("click", () =>
      document.querySelector("#privacy").showModal()
    );
  document
    .querySelector("#share-results")
    .addEventListener("click", () =>
      document.querySelector("#share").showModal()
    );
  document
    .querySelector("#copy-link")
    .addEventListener("click", copyLinkButtonClickHandler);
  document
    .querySelectorAll(".close-dialog, #close-privacy")
    .forEach((element) => {
      element.addEventListener("click", () =>
        document.querySelectorAll("dialog").forEach((modal) => modal.close())
      );
    });
}

/**
 * Event listener for clicks on the main start button
 */
function startButtonClickHandler() {
  switch (testState.state) {
    case READY:
    case FINISHED:
      // Apply the current dials first: setParameter is only legal while the
      // worker is idle, and a run must be recorded with the settings it used.
      if (window.TestParams) window.TestParams.applyTo(testState.speedtest);
      testState.speedtest.start();
      testState.initialGaugeScrollPending = true;
      testState.state = RUNNING;
      // New run: wipe the previous plot before the first samples arrive
      if (window.RealtimeChart) window.RealtimeChart.begin();
      return;
    case RUNNING:
      testState.speedtest.abort();
      // testState.state is updated by `onend` handler of speedtest
      return;
    default:
      return;
  }
}

/**
 * Scroll the initial download gauge into view on narrow viewports when starting a test
 */
function scrollInitialDownloadGaugeIntoView() {
  if (!window.matchMedia("(max-width: 800px)").matches) {
    return;
  }

  const downloadGauge = document.querySelector("#download-gauge");
  if (!downloadGauge) {
    return;
  }

  const { top, bottom } = downloadGauge.getBoundingClientRect();
  if (top >= 0 && bottom <= window.innerHeight) {
    return;
  }

  downloadGauge.scrollIntoView({
    block: "center",
    inline: "nearest",
  });
}

/**
 * Event listener for clicks on the "Copy link" button in the modal
 */
async function copyLinkButtonClickHandler() {
  const link = document.querySelector("img#results").src;
  await navigator.clipboard.writeText(link);
  const button = document.querySelector("#copy-link");
  button.classList.add("active");
  button.textContent = "Copied!";
  setTimeout(() => {
    button.classList.remove("active");
    button.textContent = "Copy link";
  }, 3000);
}

/**
 * Load settings from settings.json on the server and apply them
 */
async function applySettingsJSON() {
  try {
    const response = await fetch("settings.json");
    const settings = await response.json();
    if (!settings || typeof settings !== "object") {
      return console.error("Settings are empty or malformed");
    }
    for (let setting in settings) {
      testState.speedtest.setParameter(setting, settings[setting]);
      if (
        setting == "telemetry_level" &&
        settings[setting] &&
        settings[setting] != "off" &&
        settings[setting] != "disabled" &&
        settings[setting] != "false"
      ) {
        testState.telemetryEnabled = true;
        document.querySelector("#privacy-notice").classList.remove("hidden");
        document.querySelector("#my-results-link").classList.remove("hidden");
      }
    }
    // Server defaults are the baseline the parameter panel starts from.
    if (window.TestParams) window.TestParams.setBase(settings);
  } catch (error) {
    console.error("Failed to fetch settings:", error);
  }
}

/**
 * Load server list from the configured source and populate the dropdown
 */
async function applyServerListJSON() {
  try {
    const serverSource =
      typeof globalThis.SPEEDTEST_SERVERS !== "undefined"
        ? globalThis.SPEEDTEST_SERVERS
        : "server-list.json";
    const servers = Array.isArray(serverSource)
      ? serverSource
      : await fetch(serverSource).then((response) => response.json());
    if (!servers || !Array.isArray(servers) || servers.length === 0) {
      return console.error("Server list is empty or malformed");
    }

    testState.servers = servers;

    // If there's only one server, just show it. No reachability checks needed.
    if (servers.length === 1) {
      populateDropdown(servers);
      return;
    }

    // For multiple servers: first run the built-in selection (which pings servers
    // and annotates them with pingT). Only then populate the dropdown so that
    // dead servers don't appear.
    testState.speedtest.addTestPoints(servers);
    testState.speedtest.selectServer((bestServer) => {
      const aliveServers = testState.servers.filter((s) => {
        // Keep servers that responded to ping (pingT !== -1).
        if (s.pingT !== -1) return true;
        // Also keep protocol-relative servers ("//...") as a defensive fallback.
        // LibreSpeed normalizes them to the page protocol before pinging, so they
        // are normally treated like any other server and get a real pingT value.
        return typeof s.server === "string" && s.server.startsWith("//");
      });

      // Prefer to show only reachable servers, but if none are reachable,
      // fall back to the full list so users can still pick a server manually.
      if (aliveServers.length > 0) {
        testState.servers = aliveServers;
      }
      populateDropdown(testState.servers);


      if (bestServer) {
        selectServer(bestServer);
      } else {
        alert(
          "Can't reach any of the speedtest servers! But you're on this page. Something weird is going on with your network."
        );
      }
    });
  } catch (error) {
    console.error("Failed to load server list:", error);
  }
}

/**
 * Add all the servers to the server selection dropdown and make it actually
 * work.
 * @param {Array} servers - an array of server objects
 */
function populateDropdown(servers) {
  const serverSelector = document.querySelector("div.server-selector");
  const serverList = serverSelector.querySelector("ul.servers");

  // Reset previous state (populateDropdown can be called multiple times)
  serverSelector.classList.remove("single-server");
  serverSelector.classList.remove("active");
  serverList.classList.remove("active");
  serverList.innerHTML = "";

  // If we have only a single server, just show it
  if (servers.length === 1) {
    serverSelector.classList.add("single-server");
    selectServer(servers[0]);
    return;
  }
  serverSelector.classList.add("active");

  // Make the dropdown open and close (hook only once)
  if (serverSelector.dataset.hooked !== "1") {
    serverSelector.dataset.hooked = "1";

    serverSelector.addEventListener("click", () => {
      serverList.classList.toggle("active");
    });
    document.addEventListener("click", (e) => {
      if (e.target.closest("div.server-selector") !== serverSelector)
        serverList.classList.remove("active");
    });
  }

  // Sort servers by country, then by city within the same country.
  // Name formats: "City, Country", "City, Country (qualifier)", "City, Country, Provider", "Country"
  const parseServerName = (name) => {
    const parts = (name || "").split(",").map((s) => s.trim());
    let country, city;
    if (parts.length >= 3) {
      // "City, Country, Provider" — use second part as country
      country = parts[1];
      city = parts[0];
    } else if (parts.length === 2) {
      country = parts[1];
      city = parts[0];
    } else {
      country = parts[0];
      city = "";
    }
    // Strip parenthetical qualifiers for sorting: "Germany (1) (Hetzner)" → "Germany"
    country = country.replace(/\s*\([^)]*\)\s*/g, "").trim();
    return { country, city };
  };
  const sorted = [...servers].sort((a, b) => {
    const pa = parseServerName(a.name);
    const pb = parseServerName(b.name);
    return pa.country.localeCompare(pb.country) || pa.city.localeCompare(pb.city);
  });

  // Populate the list to choose from
  sorted.forEach((server) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    link.innerHTML = `${server.name}${
      server.sponsorName ? ` <span>(${server.sponsorName})</span>` : ""
    }`;
    link.addEventListener("click", () => selectServer(server));
    item.appendChild(link);
    serverList.appendChild(item);
  });
}

/**
 * Set the given server as the selected server for the speedtest
 * @param {Object} server - a server object
 */
function selectServer(server) {
  testState.speedtest.setSelectedServer(server);
  testState.selectedServerDirty = true;
  testState.state = READY;
}

/**
 * Say where the traffic actually goes.
 *
 * The node name above this line is a label someone chose. This is the address
 * the browser opens its sockets against, resolved from the selected node's own
 * base URL — so it stays true whether the visitor arrived by LAN address, by
 * public address or by hostname, and it needs nothing from the server to be
 * correct.
 *
 * The detail line adds the part only the server can know: its own interface
 * address, and the address the rest of the internet sees it as
 * (backend/serverInfo.php). A node that does not offer that file simply shows
 * the address and says so.
 */
async function refreshServerEndpoint() {
  const addressEl = document.querySelector("#server-address");
  if (!addressEl) return;

  let server = null;
  try {
    server = testState.speedtest.getSelectedServer();
  } catch (error) {
    return; // no server selected yet
  }
  if (!server || !server.server) return;

  let base;
  try {
    base = new URL(server.server, window.location.href);
  } catch (error) {
    return;
  }

  addressEl.textContent = base.host;

  const detail = document.querySelector("#server-detail");
  const toggle = document.querySelector("#server-detail-toggle");
  const note = document.querySelector("#server-note");
  const interfaceCell = document.querySelector("#server-interface");
  const publicCell = document.querySelector("#server-public");
  const protoCell = document.querySelector("#server-proto");

  if (toggle.dataset.hooked !== "1") {
    toggle.dataset.hooked = "1";
    toggle.addEventListener("click", () => {
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  detail.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  note.textContent = "";
  toggle.hidden = true;

  let info = null;
  try {
    const infoUrl = new URL("serverInfo.php", base);
    // A node on another origin only answers if we ask for CORS explicitly, on
    // purpose: the same rule the rest of the backend follows.
    if (base.host !== window.location.host) infoUrl.searchParams.set("cors", "true");
    const response = await fetch(infoUrl, { cache: "no-store" });
    if (response.ok) info = await response.json();
  } catch (error) {
    info = null; // an older node, a different server implementation, or CORS
  }

  const hostname = base.hostname;
  const isIpLiteral =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.indexOf(":") !== -1;

  const notes = [];
  if (!isIpLiteral) {
    notes.push("a hostname — your DNS decides which address that is");
  }
  if (info) {
    toggle.hidden = false;
    interfaceCell.textContent = info.interface || "not reported";
    publicCell.textContent = info.public || "not available";
    protoCell.textContent = info.proto || "—";

    if (info.interface) {
      notes.push(
        info.interface === hostname
          ? "this is the host's own interface"
          : "forwarded — the host itself answers on " + info.interface
      );
    }
    if (info.public) {
      notes.push(
        info.public === hostname
          ? "this is the public address"
          : "public egress is " + info.public
      );
    }
  } else {
    notes.push("this node does not report its addresses");
  }

  note.textContent = notes.join(" · ");
}

/**
 * Start the requestAnimationFrame UI rendering loop
 */
function startRenderingLoop() {
  // Do these queries once to speed up the rendering itself
  const serverSelector = document.querySelector("div.server-selector");
  const selectedServer = serverSelector.querySelector("#selected-server");
  const sponsor = serverSelector.querySelector("#sponsor");
  const startButton = document.querySelector("#start-button");
  const privacyWarning = document.querySelector("#privacy-warning");
  const headerStatus = document.querySelector("#header-status");

  const gauges = document.querySelectorAll("#download-gauge, #upload-gauge");
  const gaugeLayout = document.querySelector(".gauge-layout");
  const downloadGaugeEl = document.querySelector("#download-gauge");
  const uploadGaugeEl = document.querySelector("#upload-gauge");
  const downloadProgress = document.querySelector("#download-gauge .progress");
  const uploadProgress = document.querySelector("#upload-gauge .progress");
  const downloadGauge = document.querySelector("#download-gauge .speed");
  const uploadGauge = document.querySelector("#upload-gauge .speed");
  const downloadText = document.querySelector("#download-speed");
  const uploadText = document.querySelector("#upload-speed");

  const pingAndJitter = document.querySelectorAll(".ping, .jitter");
  const ping = document.querySelector("#ping");
  const jitter = document.querySelector("#jitter");
  const shareResults = document.querySelector("#share-results");
  const copyLink = document.querySelector("#copy-link");
  const resultsImage = document.querySelector("#results");

  const buttonTexts = {
    [INITIALIZING]: "Loading...",
    [READY]: "Let's start",
    [RUNNING]: "Abort",
    [FINISHED]: "Restart",
  };

  // The status readout in the header, same four states
  const statusTexts = {
    [INITIALIZING]: "linking...",
    [READY]: "terminal ready",
    [RUNNING]: "test running",
    [FINISHED]: "test complete",
  };

  /**
   * Keep the instrument side of the UI in step with the live measurement: how
   * bright each gauge burns, which direction is in focus, and how busy the
   * pixel backdrop looks. Runs every frame, but only writes CSS variables and
   * one data attribute, so the look itself stays in the stylesheets.
   */
  let activeDirection = "";

  function updateInstrumentation() {
    const data = testState.testData;
    const measuring = testState.state === RUNNING;

    const dlPower = measuring ? speedToPower(data && data.dlStatus) : 0;
    const ulPower = measuring ? speedToPower(data && data.ulStatus) : 0;

    if (downloadGaugeEl) {
      downloadGaugeEl.style.setProperty("--gauge-glow", (dlPower * 0.9).toFixed(3));
    }
    if (uploadGaugeEl) {
      uploadGaugeEl.style.setProperty("--gauge-glow", (ulPower * 0.9).toFixed(3));
    }

    // Focus follows activity - but only while a test is running: once it is
    // finished, both gauges are the result and should read equally.
    let direction = "";
    if (measuring && data) {
      const phase = Number(data.testState);
      if (phase === 1) direction = "download";
      else if (phase === 3) direction = "upload";
    }

    if (direction !== activeDirection) {
      activeDirection = direction;
      if (gaugeLayout) gaugeLayout.dataset.active = direction;
    }

    if (window.CrtBackground) {
      const level =
        direction === "download" ? dlPower : direction === "upload" ? ulPower : 0;
      window.CrtBackground.setActivity(level, direction);
    }
  }

  // Show copy link button only if navigator.clipboard is available
  copyLink.classList.toggle("hidden", !navigator.clipboard);

  function renderUI() {
    // Make the main button reflect the current state
    startButton.textContent = buttonTexts[testState.state];
    startButton.classList.toggle("disabled", testState.state === INITIALIZING);
    startButton.classList.toggle("active", testState.state === RUNNING);

    // Mirror it in the header status readout
    if (headerStatus) {
      headerStatus.textContent = statusTexts[testState.state];
    }

    // Disable the server selector while test is running
    serverSelector.classList.toggle("disabled", testState.state === RUNNING);

    // Show selected server
    if (testState.selectedServerDirty) {
      const server = testState.speedtest.getSelectedServer();
      selectedServer.textContent = server.name;
      if (server.sponsorName) {
        if (server.sponsorURL) {
          sponsor.innerHTML = `Sponsor: <a href="${server.sponsorURL}">${server.sponsorName}</a>`;
        } else {
          sponsor.textContent = `Sponsor: ${server.sponsorName}`;
        }
      } else {
        sponsor.innerHTML = "&nbsp;";
      }
      testState.selectedServerDirty = false;
      refreshServerEndpoint();
    }

    // Activate the gauges when test running or finished
    gauges.forEach((e) =>
      e.classList.toggle(
        "enabled",
        testState.state === RUNNING || testState.state === FINISHED
      )
    );

    updateInstrumentation();

    if (
      testState.state === RUNNING &&
      testState.initialGaugeScrollPending &&
      !testState.initialGaugeScrollScheduled
    ) {
      testState.initialGaugeScrollScheduled = true;
      requestAnimationFrame(() => {
        if (testState.state === RUNNING) {
          scrollInitialDownloadGaugeIntoView();
        }
        testState.initialGaugeScrollPending = false;
        testState.initialGaugeScrollScheduled = false;
      });
    }

    // Show ping and jitter if data is available
    pingAndJitter.forEach((e) =>
      e.classList.toggle(
        "hidden",
        !(
          testState.testData &&
          testState.testData.pingStatus &&
          testState.testData.jitterStatus
        )
      )
    );

    // Show share button after test if server supports it
    shareResults.classList.toggle(
      "hidden",
      !(
        testState.state === FINISHED &&
        testState.telemetryEnabled &&
        testState.testData.testId
      )
    );

    if (testState.testDataDirty) {
      // Set gauge rotations
      downloadProgress.style = `--progress-rotation: ${
        testState.testData.dlProgress * 180
      }deg`;
      uploadProgress.style = `--progress-rotation: ${
        testState.testData.ulProgress * 180
      }deg`;
      downloadGauge.style = `--speed-rotation: ${mbpsToRotation(
        testState.testData.dlStatus,
        testState.testData.testState === 1
      )}deg`;
      uploadGauge.style = `--speed-rotation: ${mbpsToRotation(
        testState.testData.ulStatus,
        testState.testData.testState === 3
      )}deg`;

      // Set numeric values
      downloadText.textContent = numberToText(testState.testData.dlStatus);
      uploadText.textContent = numberToText(testState.testData.ulStatus);
      ping.textContent = numberToText(testState.testData.pingStatus);
      jitter.textContent = numberToText(testState.testData.jitterStatus);

      // Set the client readout in the status bar. The "client" label and the
      // placeholder live in the markup, so only the value is written here.
      if (testState.testData.clientIp) {
        privacyWarning.textContent = testState.testData.clientIp;
      }

      // Set image for sharing results
      if (testState.testData.testId) {
        resultsImage.src =
          window.location.href.substring(
            0,
            window.location.href.lastIndexOf("/")
          ) +
          "/results/?id=" +
          testState.testData.testId +
          // Ask for the design this frontend matches; the classic frontend
          // links the same URL and gets the classic image without asking.
          "&style=modern";
      }

      testState.testDataDirty = false;
    }

    requestAnimationFrame(renderUI);
  }

  renderUI();
}

/**
 * Convert a speed in Mbits per second to a 0..1 "how hard is the link working"
 * figure, on the same log scale the gauges use. Feeds the gauge bloom and the
 * pixel backdrop, so the light on screen follows the measurement.
 * @param {string} speed Speed in Mbits
 * @returns {number} 0..1
 */
function speedToPower(speed) {
  speed = Number(speed);
  if (!(speed > 0)) return 0;

  const logMax = Math.log10(10000 + 1); // 10 Gbps maxes out the gauge
  return Math.max(0, Math.min(Math.log10(speed + 1) / logMax, 1));
}

/**
 * Convert a speed in Mbits per second to a rotation for the gauge
 * @param {string} speed Speed in Mbits
 * @param {boolean} oscillate If the gauge should wiggle a bit
 * @returns {number} Rotation for the gauge in degrees
 */
function mbpsToRotation(speed, oscillate) {
  speed = Number(speed);
  if (speed <= 0) return 0;

  const minSpeed = 0;
  const maxSpeed = 10000; // 10 Gbps maxes out the gauge
  const minRotation = 0;
  const maxRotation = 180;

  // Can't do log10 of values less than one, +1 all to keep it fair
  const logMinSpeed = Math.log10(minSpeed + 1);
  const logMaxSpeed = Math.log10(maxSpeed + 1);
  const logSpeed = Math.log10(speed + 1);

  const power = (logSpeed - logMinSpeed) / (logMaxSpeed - logMinSpeed);
  const oscillation = oscillate ? 1 + 0.01 * Math.sin(Date.now() / 100) : 1;
  const rotation = power * oscillation * maxRotation;

  // Make sure we stay within bounds at all times
  return Math.max(Math.min(rotation, maxRotation), minRotation);
}

/**
 * Convert a number to a user friendly version
 * @param {string} value Speed, ping or jitter
 * @returns {string} A text version with proper decimals
 */
function numberToText(value) {
  if (!value) return "00";
  value = Number(value);
  if (value < 10) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  return value.toFixed(0);
}
