# Playwright Plan: Test All Runtime and UI Modes

## Objective
Build a deterministic Playwright test suite that validates LibreSpeed behavior across all supported deployment modes and UI design modes, without asserting real network throughput values.

## Current Status
- Phase 1 is implemented and passing in Chromium.
- Added regression coverage for the standalone "No servers available" issue path.
- Docker image workflow is hard-gated by e2e (`build` depends on `e2e`).
- Standalone Playwright workflow is manual-only to avoid duplicate e2e runs.

## Modes to Cover

### Docker runtime modes
- `standalone`
- `backend`
- `frontend`
- `dual`

### UI design
- One page only: `index.html` (terminal / CRT design)
- No design switcher, no `config.json`, no `?design=` override

## Test Strategy

### 1. Keep assertions deterministic
Do not assert real bandwidth numbers. Focus on:
- HTTP availability of expected files/endpoints
- correct redirects/switching behavior
- expected UI controls rendered
- expected server-list loading behavior
- ability to initiate/abort flow at UI level

### 2. Separate test types
- **Mode smoke tests** (fast, always-run): verify each runtime mode serves the right surfaces.
- **UI mode tests**: verify the single page is served and wired up in every mode.
- **Optional flow tests** (later): mock `Speedtest` in browser to simulate state changes and verify UI updates.

### 3. Use Docker Compose as the environment contract
Run Playwright against containers started with explicit `MODE` values to mirror production entrypoint behavior.

## Proposed Test Matrix

### A) `standalone`
Expectations:
- `GET /` responds and serves the UI
- `GET /backend/empty.php`, `GET /backend/garbage.php`, `GET /backend/getIP.php` available
- `GET /results/telemetry.php` reachable (even if telemetry disabled behavior differs)
- `GET /index.html` serves the terminal frontend

### B) `backend`
Expectations:
- backend endpoints return success (`/backend/empty.php`, `/backend/garbage.php`, `/backend/getIP.php`)
- tests only assert local backend endpoint contracts in this mode

### C) `frontend`
Expectations:
- UI entrypoint available
- server list loads from `/servers.json` (or `SERVER_LIST_URL` if set)
- backend test endpoints should not be treated as local testpoint contract in this mode
- selecting server and pressing start does not crash UI shell

### D) `dual`
Expectations:
- combines frontend + local backend availability
- UI can load multi-server list
- backend endpoints available locally

## Playwright Architecture

### Files
- `playwright.config.js`
- `tests/e2e/modes.spec.js` (runtime-mode smoke)
- `tests/e2e/static-repository-assets.spec.js` (repo assets stay served)
- `tests/e2e/helpers/env.js` (base URLs + mode metadata)
- `tests/e2e/helpers/ui.js` (shared selectors, start/abort helpers)

### Environment boot
- `docker compose -f tests/docker-compose-playwright.yml up -d --build`
- dedicate one service per runtime mode on separate ports
- for `frontend` and `dual`, mount a stable `servers.json`

### Selector policy
Use role/text selectors anchored on stable labels and IDs already in pages; avoid brittle CSS-path selectors.

## Phased Rollout

### Phase 1 (recommended first PR)
- Add Playwright scaffolding and CI job
- Add smoke coverage for 4 Docker runtime modes
- Add design switch tests (`index.html`, `?design=new`, `?design=old`)
- No full speed measurement assertions

### Phase 2
- Add deterministic UI flow tests with mocked Speedtest state updates
- Validate button states (`Start` -> running -> abort/end)
- Validate result widgets receive simulated values

### Phase 3
- Add telemetry-enabled scenario tests (`TELEMETRY=true`) for link visibility and stats exposure
- Add negative tests (missing/invalid `servers.json` in frontend/dual)

## Risks and Mitigations
- Flaky speed measurements due to host/network variance
  - Mitigation: avoid throughput assertions; use mocked state for UI behavior.
- Divergence between local static run and Docker entrypoint behavior
  - Mitigation: run all mode tests against Docker services.
- Selector drift between the markup and the frontend scripts
  - Mitigation: maintain per-design helper selectors with minimal coupling.

## CI Proposal
- Docker workflow runs e2e first, then build/push only if e2e passes
- Standalone Playwright workflow is `workflow_dispatch` only for manual branch runs
- Keep a single automatic e2e path to avoid duplicate runs
- Playwright retries: `1` in CI, `0` locally
- Upload traces/screenshots on failure only
- Browser scope for v1: Chromium only

## Confirmed Decisions
1. Browser scope for v1: Chromium only.
2. Telemetry checks are deferred to Phase 3.
3. `backend` mode tests assert backend endpoint contracts only.
4. Automatic e2e gating lives in Docker workflow; standalone Playwright workflow is manual.
