import { FanOptimizer, SAMPLE_INTERVAL_MS, clamp, isOptimized, FAN_TYPES, defaultFanType, CPU_TARGET_PRESETS } from "./optimizer.js";
import { BrowserSimAdapter } from "./sim-adapter.js";
import { buildFanControlConfig } from "./fancontrol-export.js";

const FAN_PROFILE_KEY = "automatic-fan-tuner-profile-v1";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auto-detect tuning: at 100% PWM any connected fan spins well above this; an empty
// header (or a dead one) stays at ~0 RPM, so this threshold separates the two.
const PRESENCE_RPM = 200;
const SPINUP_SETTLE_MS = 2500;

class PawnIoAdapter {
  // In the desktop app the UI is served by the bridge itself, so API calls are
  // same-origin relative URLs. When developing the UI from another origin (e.g. the
  // old Node dev server), fall back to the bridge's fixed address.
  constructor(endpoint = location.port === "9876" ? "" : "http://127.0.0.1:9876") {
    this.name = "PawnIO bridge adapter";
    this.endpoint = endpoint;
  }

  async connect() {
    const response = await fetch(`${this.endpoint}/capabilities`);
    if (!response.ok) throw new Error("PawnIO bridge is unavailable");
    return response.json();
  }

  async setFanPwm(fanId, pwm) {
    await fetch(`${this.endpoint}/fans/${encodeURIComponent(fanId)}/pwm`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pwm })
    });
  }

  async updateFan(fanId, patch) {
    await fetch(`${this.endpoint}/fans/${encodeURIComponent(fanId)}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
  }

  async readTelemetry() {
    const response = await fetch(`${this.endpoint}/telemetry`);
    if (!response.ok) throw new Error("Unable to read PawnIO telemetry");
    return response.json();
  }
}

class LoadController {
  constructor(canvas) {
    this.canvas = canvas;
    this.cpuWorkers = [];
    this.gpuFrame = 0;
    this.gpuProgram = null;
    this.gl = null;
    this.mode = "idle";
  }

  start(mode) {
    this.stop();
    this.mode = mode;
    if (mode === "cpu" || mode === "system") this.startCpuLoad();
    if (mode === "gpu" || mode === "system") this.startGpuLoad();
  }

  stop() {
    for (const worker of this.cpuWorkers) {
      worker.postMessage({ type: "stop" });
      worker.terminate();
    }
    this.cpuWorkers = [];

    if (this.gpuFrame) cancelAnimationFrame(this.gpuFrame);
    this.gpuFrame = 0;
    if (this.gl) {
      // Drop the high-resolution backing buffer when the load stops.
      this.canvas.width = 480;
      this.canvas.height = 240;
      this.gl = null;
    }
    this.mode = "idle";
  }

  getState() {
    return {
      mode: this.mode,
      cpu: this.mode === "cpu" || this.mode === "system",
      gpu: this.mode === "gpu" || this.mode === "system"
    };
  }

  startCpuLoad() {
    const workerCount = clamp(navigator.hardwareConcurrency || 4, 1, 16);
    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker("./cpu-worker.js");
      worker.postMessage({ type: "start", intensity: 1 });
      this.cpuWorkers.push(worker);
    }
  }

  startGpuLoad() {
    // Render at a high backing resolution with a heavy fragment shader, several
    // passes per frame, so the GPU is saturated instead of idling at vsync. The
    // canvas CSS size is unchanged — only the internal buffer grows.
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    const gl = this.canvas.getContext("webgl2") || this.canvas.getContext("webgl");
    if (!gl) return;
    this.gl = gl;

    const vertex = createShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform float time;
      uniform float pass;
      void main() {
        vec2 uv = gl_FragCoord.xy / vec2(1920.0, 1080.0);
        vec3 color = vec3(0.0);
        float v = 0.0;
        for (int i = 0; i < 220; i++) {
          float f = float(i) + pass * 13.7;
          vec2 p = uv - vec2(0.5 + sin(time * 0.001 + f) * 0.14, 0.5 + cos(time * 0.0017 + f) * 0.14);
          float d = max(dot(p, p), 0.0004);
          v += 0.004 / d;
          // Extra transcendental work per tap keeps the ALUs busy, not just the
          // rasterizer.
          float w = sin(d * 41.0 + time * 0.002 + f) * cos(d * 29.0 - f * 0.31);
          v += w * w * 0.002;
          color += vec3(sin(v + f * 0.07), cos(v + f * 0.03), sin(v + f * 0.11)) * 0.002;
          color += vec3(pow(abs(sin(v * 0.5 + f)), 3.0)) * 0.0005;
        }
        gl_FragColor = vec4(color + vec3(v * 0.02, v * 0.015, v * 0.01), 1.0);
      }
    `);
    this.gpuProgram = createProgram(gl, vertex, fragment);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(this.gpuProgram, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const timeUniform = gl.getUniformLocation(this.gpuProgram, "time");
    const passUniform = gl.getUniformLocation(this.gpuProgram, "pass");
    const PASSES_PER_FRAME = 6;

    const render = (time) => {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.gpuProgram);
      gl.uniform1f(timeUniform, time);
      for (let pass = 0; pass < PASSES_PER_FRAME; pass += 1) {
        gl.uniform1f(passUniform, pass);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.flush();
      this.gpuFrame = requestAnimationFrame(render);
    };

    this.gpuFrame = requestAnimationFrame(render);
  }
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Unable to compile shader");
  }
  return shader;
}

function createProgram(gl, vertex, fragment) {
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Unable to link shader program");
  }
  return program;
}

const elements = {
  adapterStatus: document.querySelector("#adapter-status"),
  calibrationState: document.querySelector("#calibration-state"),
  fanList: document.querySelector("#fan-list"),
  loadState: document.querySelector("#load-state"),
  sampleCount: document.querySelector("#sample-count"),
  cpuTemp: document.querySelector("#cpu-temp"),
  gpuTemp: document.querySelector("#gpu-temp"),
  caseTemp: document.querySelector("#case-temp"),
  optimizerMode: document.querySelector("#optimizer-mode"),
  scenarioPoints: document.querySelector("#scenario-points"),
  optimizerLog: document.querySelector("#optimizer-log"),
  curveChart: document.querySelector("#curve-chart"),
  curveGrid: document.querySelector("#curve-grid"),
  profileJson: document.querySelector("#profile-json"),
  startOptimizer: document.querySelector("#start-optimizer"),
  stopAll: document.querySelector("#stop-all"),
  exportProfile: document.querySelector("#export-profile"),
  exportFanControl: document.querySelector("#export-fancontrol"),
  autoDetect: document.querySelector("#auto-detect"),
  autoOptimize: document.querySelector("#auto-optimize"),
  autoStatus: document.querySelector("#auto-status"),
  autoProgress: document.querySelector("#auto-progress"),
  cpuTarget: document.querySelector("#cpu-target"),
  gpuCanvas: document.querySelector("#gpu-canvas")
};

// While the auto-detect sweep runs, the periodic loop should not fight it for the
// calibration status line or write PWM.
let detecting = false;

// One-click optimization routine state.
let autoRun = { active: false, abort: false, doneMs: 0 };

// Raw temperature sensor identifiers reported by the adapter, used for FanControl
// config export.
let sensorIdentifiers = null;

const activityLog = [];

function logActivity(message) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  activityLog.unshift(`${time}  ${message}`);
  if (activityLog.length > 80) activityLog.pop();
  elements.optimizerLog.textContent = activityLog.join("\n");
}

const loadController = new LoadController(elements.gpuCanvas);
const optimizer = new FanOptimizer();
const adapter = await initializeAdapter();
let telemetry = await adapter.readTelemetry(loadController.getState());

// Restore learned scenario points from the last session so a reload doesn't wipe
// everything the optimizer recorded.
const savedProfile = loadProfile();
if (savedProfile?.rawScenarioPoints) {
  optimizer.hydrate(savedProfile.rawScenarioPoints);
  const counts = optimizer.scenarioCounts();
  const restored = counts.cpu + counts.gpu + counts.system;
  if (restored > 0) logActivity(`Restored ${restored} learned scenario points from the previous session`);
}
if (savedProfile?.optimizer?.targets?.cpuTempC) {
  optimizer.setCpuTarget(savedProfile.optimizer.targets.cpuTempC);
}
elements.cpuTarget.value = optimizer.targets.cpuTempC;
let profile = optimizer.buildProfile(telemetry.fans);

renderAll();

setInterval(async () => {
  if (detecting) return; // the sweep owns the fans while it runs
  telemetry = await adapter.readTelemetry(loadController.getState());

  if (optimizer.mode === "optimizing") {
    const loadState = loadController.getState();
    const before = new Map(telemetry.fans.map((fan) => [fan.id, fan.pwm]));
    const labels = new Map(telemetry.fans.map((fan) => [fan.id, fan.label]));
    const recommendations = optimizer.recommend(telemetry, loadState);
    await Promise.all(recommendations.map((item) => adapter.setFanPwm(item.fanId, item.pwm)));

    const changed = recommendations.filter((item) => Math.round(before.get(item.fanId) ?? -1) !== item.pwm);
    if (changed.length) {
      const moves = changed
        .map((item) => `${labels.get(item.fanId) ?? item.fanId} ${Math.round(before.get(item.fanId))}→${item.pwm}%`)
        .join(" · ");
      const scenario = loadState.mode !== "idle" ? ` [learning ${loadState.mode}]` : "";
      logActivity(`${moves} — CPU ${telemetry.sensors.cpuTempC.toFixed(1)}°C${scenario}`);
    }

    telemetry = await adapter.readTelemetry(loadController.getState());
  }

  profile = optimizer.buildProfile(telemetry.fans);
  saveProfile(profile);
  renderAll();
}, SAMPLE_INTERVAL_MS);

elements.startOptimizer.addEventListener("click", () => {
  optimizer.start();
  const loadState = loadController.getState();
  logActivity(loadState.mode === "idle"
    ? "Optimizer started — start a load test to record scenario curves"
    : `Optimizer started — learning ${loadState.mode} scenario`);
  renderAll();
});

elements.stopAll.addEventListener("click", async () => {
  if (autoRun.active) {
    autoRun.abort = true; // the routine handles its own teardown
    return;
  }
  optimizer.stop();
  loadController.stop();
  // Only park fans we manage; GPU/ignored fans stay on BIOS control.
  for (const fan of telemetry.fans.filter(isOptimized)) {
    await adapter.setFanPwm(fan.id, Math.max(fan.minPwm, 30));
  }
  logActivity("Stopped — optimizer idle, loads off, managed fans parked at 30%");
  renderAll();
});

elements.exportProfile.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `fan-profile-${new Date().toISOString().replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  const counts = optimizer.scenarioCounts();
  logActivity(`Exported profile (${counts.cpu} cpu / ${counts.gpu} gpu / ${counts.system} system learned points)`);
});

elements.exportFanControl.addEventListener("click", () => {
  const config = buildFanControlConfig(profile, telemetry.fans, sensorIdentifiers);
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `fancontrol-aft-${new Date().toISOString().replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  logActivity(`Exported FanControl config (${profile.fans.length} curves, ${telemetry.fans.length} controls)`);
});

elements.cpuTarget.addEventListener("change", () => {
  const applied = optimizer.setCpuTarget(Number(elements.cpuTarget.value) || optimizer.targets.cpuTempC);
  elements.cpuTarget.value = applied;
  logActivity(`CPU temperature target set to ${applied}°C`);
  renderAll();
});

document.querySelectorAll("[data-target-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const preset = button.dataset.targetPreset;
    const applied = optimizer.setCpuTarget(CPU_TARGET_PRESETS[preset]);
    elements.cpuTarget.value = applied;
    logActivity(`CPU temperature target set to ${applied}°C (${preset} preset)`);
    renderAll();
  });
});

elements.autoDetect.addEventListener("click", () => autoDetectFans());

// Ramp each controllable motherboard header to 100% one at a time, see whether RPM
// responds, and mark non-responding (empty/dead) headers as "ignore". GPU fans are
// left untouched — they stay on BIOS control.
async function autoDetectFans() {
  if (detecting) return;
  optimizer.stop();

  const candidates = telemetry.fans.filter(
    (fan) => fan.source !== "gpu" && fan.controllable !== false
  );
  if (!candidates.length) {
    elements.calibrationState.textContent = "No controllable motherboard fans to test";
    return;
  }

  detecting = true;
  elements.autoDetect.disabled = true;
  const restore = new Map(candidates.map((fan) => [fan.id, fan.pwm]));
  let connected = 0;

  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const fan = candidates[index];
      elements.calibrationState.textContent =
        `Detecting ${index + 1}/${candidates.length}: ${fan.label}…`;

      await adapter.setFanPwm(fan.id, 100);
      await delay(SPINUP_SETTLE_MS);
      const probe = await adapter.readTelemetry(loadController.getState());
      const rpm = probe.fans.find((item) => item.id === fan.id)?.rpm ?? 0;

      await adapter.setFanPwm(fan.id, restore.get(fan.id));

      if (rpm < PRESENCE_RPM) {
        await adapter.updateFan(fan.id, { role: "ignore" });
      } else {
        connected += 1;
        if (fan.role === "ignore") {
          // A header that clearly has a fan shouldn't stay ignored; default it to a
          // system fan and let the user reassign CPU if appropriate.
          await adapter.updateFan(fan.id, { role: "case" });
        }
      }
    }
    logActivity(`Auto-detect finished: ${connected}/${candidates.length} headers have fans connected`);
  } finally {
    detecting = false;
    elements.autoDetect.disabled = false;
    telemetry = await adapter.readTelemetry(loadController.getState());
    renderAll();
  }
}

// ----- One-click optimization -----------------------------------------------------
//
// Runs every load scenario in sequence. Each scenario gets a heat-soak phase (load on,
// fans managed, but nothing recorded — components approach steady state within safe
// limits) followed by a measurement phase (scenario points recorded), then a cooldown
// before the next scenario so each one starts from a comparable baseline.
const AUTO_PLAN = [
  { scenario: "cpu", soakMs: 90_000, measureMs: 120_000, cooldownMs: 60_000 },
  { scenario: "gpu", soakMs: 90_000, measureMs: 120_000, cooldownMs: 60_000 },
  { scenario: "system", soakMs: 120_000, measureMs: 150_000, cooldownMs: 0 }
];

const autoTotalMs = () => AUTO_PLAN.reduce((sum, step) => sum + step.soakMs + step.measureMs + step.cooldownMs, 0);

const formatDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

elements.autoOptimize.addEventListener("click", () => runAutoOptimization());

async function runAutoOptimization() {
  if (autoRun.active || detecting) return;
  autoRun = { active: true, abort: false, doneMs: 0 };
  elements.autoOptimize.disabled = true;
  elements.autoDetect.disabled = true;
  optimizer.start();
  logActivity(`Auto-optimization started — ~${formatDuration(autoTotalMs())} estimated (soak → measure → cooldown per scenario)`);
  const baselineCpu = telemetry.sensors.cpuTempC;

  try {
    for (const step of AUTO_PLAN) {
      if (autoRun.abort) break;
      await runPhase(`Heat soak — ${step.scenario.toUpperCase()}`, step.soakMs, {
        load: step.scenario,
        capture: false,
        // A soak is done early once the CPU temperature has flattened out.
        earlyExit: () => cpuTempFlat()
      });
      if (autoRun.abort) break;
      await runPhase(`Measuring — ${step.scenario.toUpperCase()}`, step.measureMs, {
        load: step.scenario,
        capture: true
      });
      if (autoRun.abort || !step.cooldownMs) continue;
      await runPhase("Cooldown", step.cooldownMs, {
        load: "idle",
        capture: false,
        earlyExit: () => telemetry.sensors.cpuTempC <= baselineCpu + 6
      });
    }
  } finally {
    optimizer.captureEnabled = true;
    loadController.stop();
    optimizer.stop();
    for (const fan of telemetry.fans.filter(isOptimized)) {
      await adapter.setFanPwm(fan.id, Math.max(fan.minPwm, 30));
    }
    const counts = optimizer.scenarioCounts();
    logActivity(autoRun.abort
      ? "Auto-optimization aborted — partial scenario data kept"
      : `Auto-optimization complete — learned points: cpu=${counts.cpu} gpu=${counts.gpu} system=${counts.system}. Universal profile rebuilt.`);
    autoRun = { active: false, abort: false, doneMs: 0 };
    elements.autoOptimize.disabled = false;
    elements.autoDetect.disabled = false;
    elements.autoStatus.textContent = "Idle";
    elements.autoProgress.style.width = "0%";
    renderAll();
  }
}

async function runPhase(label, durationMs, { load, capture, earlyExit }) {
  if (loadController.mode !== load) {
    if (load === "idle") loadController.stop();
    else loadController.start(load);
  }
  optimizer.captureEnabled = capture;
  renderAll();

  const start = performance.now();
  const safeLimitC = Math.min(optimizer.targets.cpuTempC + 10, 95);

  while (!autoRun.abort) {
    const elapsed = performance.now() - start;
    if (elapsed >= durationMs) break;
    updateAutoProgress(label, elapsed, durationMs);

    if (telemetry.sensors.cpuTempC >= safeLimitC) {
      logActivity(`Safety: CPU ${telemetry.sensors.cpuTempC.toFixed(1)}°C ≥ ${safeLimitC}°C — managed fans to 100%, ending phase early`);
      for (const fan of telemetry.fans.filter(isOptimized)) {
        await adapter.setFanPwm(fan.id, 100);
      }
      break;
    }
    // Give every phase at least 20 s before allowing an early exit so transient
    // flatness right after a load change can't cut a phase short.
    if (earlyExit && elapsed > 20_000 && earlyExit()) {
      logActivity(`${label}: finished early (condition reached at ${formatDuration(elapsed)})`);
      break;
    }
    await delay(1000);
  }

  // Credit the full planned duration so progress/ETA always move forward.
  autoRun.doneMs += durationMs;
}

function updateAutoProgress(label, phaseElapsed, phaseDuration) {
  const total = autoTotalMs();
  const consumed = Math.min(autoRun.doneMs + Math.min(phaseElapsed, phaseDuration), total);
  elements.autoProgress.style.width = `${((consumed / total) * 100).toFixed(1)}%`;
  elements.autoStatus.textContent = `${label} — ${formatDuration(total - consumed)} remaining`;
}

// True when the CPU temperature has stopped climbing (heat soak reached): less than
// 1°C of movement across the last 12 optimizer samples (~12 s).
function cpuTempFlat() {
  const recent = optimizer.samples.slice(-12).map((sample) => sample.sensors.cpuTempC);
  if (recent.length < 12) return false;
  return Math.max(...recent) - Math.min(...recent) < 1.0;
}

document.querySelectorAll("[data-load]").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.load;
    if (loadController.mode === mode) {
      loadController.stop();
      logActivity(`${mode.toUpperCase()} load stopped`);
    } else {
      loadController.start(mode);
      logActivity(`${mode.toUpperCase()} load started${optimizer.mode === "optimizing" ? ` — learning ${mode} scenario` : ""}`);
    }
    renderAll();
  });
});

async function initializeAdapter() {
  const requested = new URLSearchParams(location.search).get("adapter");
  // Default: try the real hardware bridge first, fall back to the simulator.
  // ?adapter=sim forces simulation; ?adapter=pawnio forces the bridge (no fallback,
  // so a connection failure is visible in the status line).
  const candidates = requested === "sim"
    ? [new BrowserSimAdapter()]
    : requested === "pawnio"
      ? [new PawnIoAdapter()]
      : [new PawnIoAdapter(), new BrowserSimAdapter()];

  for (const candidate of candidates) {
    try {
      const capabilities = await candidate.connect();
      sensorIdentifiers = capabilities.sensorIdentifiers ?? null;
      elements.adapterStatus.textContent = `${capabilities.adapter} connected with ${capabilities.fans.length} controllable fans`;
      return candidate;
    } catch (error) {
      console.warn(error);
    }
  }

  throw new Error("No hardware adapter is available");
}

function renderAll() {
  const loadState = loadController.getState();
  elements.loadState.textContent = loadState.mode === "idle" ? "Idle" : `${loadState.mode.toUpperCase()} load running`;
  elements.sampleCount.textContent = `${optimizer.samples.length} samples`;
  renderMetric(elements.cpuTemp, telemetry?.sensors.cpuTempC, optimizer.targets.cpuTempC);
  renderMetric(elements.gpuTemp, telemetry?.sensors.gpuTempC, optimizer.targets.gpuTempC);
  renderMetric(elements.caseTemp, telemetry?.sensors.caseTempC, optimizer.targets.caseTempC);

  if (optimizer.mode === "optimizing") {
    elements.optimizerMode.textContent = loadState.mode === "idle" ? "Holding" : "Learning";
    elements.optimizerMode.title = loadState.mode === "idle"
      ? "Optimizer is adjusting fans but no load test is running, so no scenario data is being recorded"
      : `Recording ${loadState.mode} scenario points`;
  } else {
    elements.optimizerMode.textContent = "Idle";
    elements.optimizerMode.title = "";
  }

  const counts = optimizer.scenarioCounts();
  elements.scenarioPoints.textContent = `${counts.cpu} · ${counts.gpu} · ${counts.system}`;

  document.querySelectorAll("[data-load]").forEach((button) => {
    button.classList.toggle("active", loadState.mode === button.dataset.load);
    button.disabled = autoRun.active;
  });
  elements.startOptimizer.disabled = optimizer.mode === "optimizing" || autoRun.active;
  elements.startOptimizer.textContent = optimizer.mode === "optimizing" ? "Optimizing…" : "Start Optimizer";

  const detectedFans = telemetry?.fans ?? [];
  const optimizedFans = detectedFans.filter(isOptimized);
  if (!detecting) {
    elements.calibrationState.textContent =
      `${optimizedFans.length}/${detectedFans.length} fans optimized` +
      (optimizedFans.length === 0 ? " — none assigned" : "");
  }
  elements.profileJson.value = JSON.stringify(profile, null, 2);
  renderFans();
  renderCurveChart();
  renderCurves();
}

// ----- Curve visualizer ------------------------------------------------------------

const CURVE_COLORS = ["#41c7a3", "#f0b84b", "#6aa9ff", "#ef6868", "#b07fe8", "#7fe8c9", "#e8a07f"];

const escapeSvg = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Draws every optimized fan's universal curve (PWM vs. temperature) plus a live
// marker at the current CPU temperature.
function renderCurveChart() {
  const width = 860;
  const height = 340;
  const margin = { top: 46, right: 18, bottom: 34, left: 46 };
  const x0 = margin.left;
  const x1 = width - margin.right;
  const y0 = height - margin.bottom;
  const y1 = margin.top;
  const tempMin = 25;
  const tempMax = 90;
  const xOf = (tempC) => x0 + ((tempC - tempMin) / (tempMax - tempMin)) * (x1 - x0);
  const yOf = (pwm) => y0 - (pwm / 100) * (y0 - y1);

  let svg = "";

  for (let t = 30; t <= 90; t += 10) {
    svg += `<line class="chart-grid" x1="${xOf(t)}" y1="${y0}" x2="${xOf(t)}" y2="${y1}"/>`;
    svg += `<text class="chart-axis" x="${xOf(t)}" y="${y0 + 18}" text-anchor="middle">${t}°</text>`;
  }
  for (let p = 0; p <= 100; p += 20) {
    svg += `<line class="chart-grid" x1="${x0}" y1="${yOf(p)}" x2="${x1}" y2="${yOf(p)}"/>`;
    svg += `<text class="chart-axis" x="${x0 - 8}" y="${yOf(p) + 4}" text-anchor="end">${p}%</text>`;
  }

  // Live marker: where the CPU is right now.
  const cpuNow = telemetry?.sensors.cpuTempC;
  if (typeof cpuNow === "number" && cpuNow >= tempMin && cpuNow <= tempMax) {
    svg += `<line class="chart-marker" x1="${xOf(cpuNow)}" y1="${y0}" x2="${xOf(cpuNow)}" y2="${y1}"/>`;
    svg += `<text class="chart-marker-label" x="${xOf(cpuNow) + 5}" y="${y1 + 12}">CPU ${cpuNow.toFixed(1)}°</text>`;
  }

  profile.fans.forEach((fan, index) => {
    const color = CURVE_COLORS[index % CURVE_COLORS.length];
    const visible = fan.curve.filter((point) => point.tempC >= tempMin && point.tempC <= tempMax);
    if (!visible.length) return;

    const points = visible.map((point) => `${xOf(point.tempC).toFixed(1)},${yOf(point.pwm).toFixed(1)}`).join(" ");
    svg += `<polyline class="chart-line" points="${points}" stroke="${color}"/>`;
    for (const point of visible) {
      svg += `<circle class="chart-dot" cx="${xOf(point.tempC).toFixed(1)}" cy="${yOf(point.pwm).toFixed(1)}" r="3" fill="${color}"/>`;
    }

    // Current PWM dot for this fan, placed at its live duty on the curve's x-extent.
    const live = telemetry?.fans.find((item) => item.id === fan.id);
    if (live && typeof cpuNow === "number" && cpuNow >= tempMin && cpuNow <= tempMax) {
      svg += `<circle class="chart-live" cx="${xOf(cpuNow).toFixed(1)}" cy="${yOf(live.pwm).toFixed(1)}" r="5" stroke="${color}"/>`;
    }

    // Legend (wraps onto a second row when there are many fans).
    const legendX = x0 + (index % 4) * 200;
    const legendY = 16 + Math.floor(index / 4) * 18;
    const roleText = fan.role === "cpu" ? "CPU" : "System";
    svg += `<rect x="${legendX}" y="${legendY - 9}" width="14" height="4" rx="2" fill="${color}"/>`;
    svg += `<text class="chart-legend" x="${legendX + 20}" y="${legendY}">${escapeSvg(fan.label)} · ${roleText}</text>`;
  });

  if (!profile.fans.length) {
    svg += `<text class="chart-axis" x="${(x0 + x1) / 2}" y="${(y0 + y1) / 2}" text-anchor="middle">No optimized fans — assign CPU/System roles in Calibration</text>`;
  }

  elements.curveChart.innerHTML = svg;
}

function renderMetric(element, value, target) {
  element.textContent = value === undefined || value === null ? "--" : value.toFixed(1);
  element.classList.toggle("hot", typeof value === "number" && value > target);
}

function renderFans() {
  elements.fanList.replaceChildren(...telemetry.fans.map((fan) => {
    const row = document.createElement("div");
    row.className = "fan-row";

    const label = document.createElement("label");
    label.textContent = "Label";
    const input = document.createElement("input");
    input.value = fan.label;
    input.addEventListener("change", async () => {
      await adapter.updateFan(fan.id, { label: input.value.trim() || fan.id });
      telemetry = await adapter.readTelemetry(loadController.getState());
      renderAll();
    });
    label.append(input);

    const roleLabel = document.createElement("label");
    roleLabel.textContent = "Role";
    const role = document.createElement("select");
    const roleLabels = { cpu: "CPU cooler", case: "System fan", ignore: "Ignore (GPU/BIOS)" };
    for (const option of ["cpu", "case", "ignore"]) {
      const item = document.createElement("option");
      item.value = option;
      item.textContent = roleLabels[option];
      item.selected = fan.role === option;
      role.append(item);
    }
    role.addEventListener("change", async () => {
      // Changing role resets the detail type to that role's default.
      await adapter.updateFan(fan.id, { role: role.value, fanType: defaultFanType(role.value) });
      telemetry = await adapter.readTelemetry(loadController.getState());
      renderAll();
    });
    roleLabel.append(role);

    // Detail type select (Air/AIO for CPU; intake/exhaust placement for case fans).
    const typeOptions = FAN_TYPES[fan.role];
    let typeLabel = null;
    if (typeOptions) {
      typeLabel = document.createElement("label");
      typeLabel.textContent = "Type";
      const type = document.createElement("select");
      const current = fan.fanType || defaultFanType(fan.role);
      for (const option of typeOptions) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        item.selected = current === option.value;
        type.append(item);
      }
      type.addEventListener("change", async () => {
        await adapter.updateFan(fan.id, { fanType: type.value });
        telemetry = await adapter.readTelemetry(loadController.getState());
        logActivity(`${fan.label} type set to ${type.options[type.selectedIndex].text}`);
        renderAll();
      });
      typeLabel.append(type);
    }

    const meta = document.createElement("div");
    meta.className = "fan-meta";
    meta.append(
      chip(fan.source ?? "?", `source-${fan.source ?? "unknown"}`),
      chip(`${fan.pwm}% PWM`),
      chip(`${fan.rpm} RPM`, fan.rpm > 0 ? "spinning" : ""),
      chip(fan.controllable === false ? "read-only" : isOptimized(fan) ? "optimized" : "not optimized",
        fan.controllable === false ? "" : isOptimized(fan) ? "managed" : "")
    );

    const actions = document.createElement("div");
    actions.className = "fan-actions";
    actions.append(
      fanButton("0%", "danger", async () => setAndRefresh(fan.id, 0)),
      fanButton("35%", "secondary", async () => setAndRefresh(fan.id, 35)),
      fanButton("100%", "warn", async () => setAndRefresh(fan.id, 100))
    );

    if (typeLabel) row.append(label, roleLabel, typeLabel, meta, actions);
    else row.append(label, roleLabel, meta, actions);
    return row;
  }));
}

function chip(text, extraClass = "") {
  const span = document.createElement("span");
  span.className = `chip${extraClass ? ` ${extraClass}` : ""}`;
  span.textContent = text;
  return span;
}

function renderCurves() {
  elements.curveGrid.replaceChildren(...profile.fans.map((fan) => {
    const card = document.createElement("div");
    card.className = "curve-card";
    const title = document.createElement("strong");
    title.textContent = `${fan.label} curve`;
    const points = document.createElement("div");
    points.className = "curve-points";
    points.replaceChildren(...fan.curve.map((point) => {
      const item = document.createElement("span");
      item.textContent = `${point.tempC}° ${point.pwm}%`;
      return item;
    }));
    card.append(title, points);
    return card;
  }));
}

function fanButton(text, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

async function setAndRefresh(fanId, pwm) {
  await adapter.setFanPwm(fanId, pwm);
  telemetry = await adapter.readTelemetry(loadController.getState());
  renderAll();
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(FAN_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveProfile(nextProfile) {
  localStorage.setItem(FAN_PROFILE_KEY, JSON.stringify(nextProfile));
}
