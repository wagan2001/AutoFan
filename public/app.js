import { FanOptimizer, SAMPLE_INTERVAL_MS, clamp, isOptimized } from "./optimizer.js";
import { BrowserSimAdapter } from "./sim-adapter.js";

const FAN_PROFILE_KEY = "automatic-fan-tuner-profile-v1";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auto-detect tuning: at 100% PWM any connected fan spins well above this; an empty
// header (or a dead one) stays at ~0 RPM, so this threshold separates the two.
const PRESENCE_RPM = 200;
const SPINUP_SETTLE_MS = 2500;

class PawnIoAdapter {
  constructor(endpoint = "http://127.0.0.1:9876") {
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
      void main() {
        vec2 uv = gl_FragCoord.xy / vec2(480.0, 240.0);
        vec3 color = vec3(0.0);
        float v = 0.0;
        for (int i = 0; i < 96; i++) {
          float f = float(i);
          vec2 p = uv - vec2(0.5 + sin(time * 0.001 + f) * 0.12, 0.5 + cos(time * 0.0017 + f) * 0.12);
          v += 0.004 / max(dot(p, p), 0.0004);
          color += vec3(sin(v + f * 0.07), cos(v + f * 0.03), sin(v + f * 0.11)) * 0.002;
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

    const render = (time) => {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.gpuProgram);
      gl.uniform1f(gl.getUniformLocation(this.gpuProgram, "time"), time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
  curveGrid: document.querySelector("#curve-grid"),
  profileJson: document.querySelector("#profile-json"),
  startOptimizer: document.querySelector("#start-optimizer"),
  stopAll: document.querySelector("#stop-all"),
  exportProfile: document.querySelector("#export-profile"),
  autoDetect: document.querySelector("#auto-detect"),
  gpuCanvas: document.querySelector("#gpu-canvas")
};

// While the auto-detect sweep runs, the periodic loop should not fight it for the
// calibration status line or write PWM.
let detecting = false;

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
  });
  elements.startOptimizer.disabled = optimizer.mode === "optimizing";
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
  renderCurves();
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
      await adapter.updateFan(fan.id, { role: role.value });
      telemetry = await adapter.readTelemetry(loadController.getState());
      renderAll();
    });
    roleLabel.append(role);

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

    row.append(label, roleLabel, meta, actions);
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
