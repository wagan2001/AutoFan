const FAN_PROFILE_KEY = "automatic-fan-tuner-profile-v1";
const SAMPLE_INTERVAL_MS = 1000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, places = 1) => Number(value.toFixed(places));

// Only motherboard/EC fans are optimization targets. GPU fans (and anything the user
// marks "ignore") are left to BIOS control, matching the project's scope.
const OPTIMIZED_ROLES = new Set(["cpu", "case"]);
const isOptimized = (fan) => OPTIMIZED_ROLES.has(fan.role);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auto-detect tuning: at 100% PWM any connected fan spins well above this; an empty
// header (or a dead one) stays at ~0 RPM, so this threshold separates the two.
const PRESENCE_RPM = 200;
const SPINUP_SETTLE_MS = 2500;

class BrowserSimAdapter {
  constructor() {
    this.name = "Browser simulation adapter";
    this.lastUpdate = performance.now();
    this.fans = [
      { id: "cpu_cooler", label: "CPU cooler", role: "cpu", source: "motherboard", pwm: 35, rpm: 850, minPwm: 20, maxPwm: 100 },
      { id: "case_intake", label: "Case intake", role: "case", source: "motherboard", pwm: 30, rpm: 620, minPwm: 18, maxPwm: 100 },
      { id: "case_exhaust", label: "Case exhaust", role: "case", source: "motherboard", pwm: 30, rpm: 650, minPwm: 18, maxPwm: 100 },
      { id: "gpu_fan", label: "GPU fan", role: "ignore", source: "gpu", pwm: 40, rpm: 1100, minPwm: 0, maxPwm: 100 }
    ];
    this.temps = { cpu: 36, gpu: 34, case: 31, ambient: 23 };
  }

  async connect() {
    return {
      adapter: this.name,
      fans: this.fans.map((fan) => ({ ...fan })),
      capabilities: ["readSensors", "setFanPwm", "syntheticTelemetry"]
    };
  }

  async setFanPwm(fanId, pwm) {
    const fan = this.fans.find((item) => item.id === fanId);
    if (!fan) return;
    fan.pwm = pwm === 0 ? 0 : clamp(pwm, fan.minPwm, fan.maxPwm);
    fan.rpm = fan.pwm === 0 ? 0 : Math.round(220 + fan.pwm * 22 + Math.random() * 35);
  }

  async updateFan(fanId, patch) {
    const fan = this.fans.find((item) => item.id === fanId);
    if (!fan) return;
    Object.assign(fan, patch);
  }

  async readTelemetry(load) {
    const now = performance.now();
    const dt = clamp((now - this.lastUpdate) / 1000, 0.1, 2);
    this.lastUpdate = now;

    const cpuLoad = load.cpu ? 1 : 0.08;
    const gpuLoad = load.gpu ? 1 : 0.06;
    const cpuFan = this.fanByRole("cpu");
    const caseFans = this.fans.filter((fan) => fan.role === "case");
    const casePwm = average(caseFans.map((fan) => fan.pwm), 30);

    const cpuTarget = this.temps.ambient + 13 + cpuLoad * 61 - cpuFan.pwm * 0.43 - casePwm * 0.07;
    const gpuTarget = this.temps.ambient + 11 + gpuLoad * 56 - casePwm * 0.22;
    const caseTarget = this.temps.ambient + 7 + cpuLoad * 8 + gpuLoad * 13 - casePwm * 0.16;

    this.temps.cpu += (cpuTarget - this.temps.cpu) * 0.05 * dt;
    this.temps.gpu += (gpuTarget - this.temps.gpu) * 0.045 * dt;
    this.temps.case += (caseTarget - this.temps.case) * 0.035 * dt;

    for (const fan of this.fans) {
      fan.rpm = fan.pwm === 0 ? 0 : Math.round(220 + fan.pwm * 22 + Math.random() * 45);
    }

    return {
      timestamp: new Date().toISOString(),
      sensors: {
        cpuTempC: round(this.temps.cpu + noise(0.25)),
        gpuTempC: round(this.temps.gpu + noise(0.25)),
        caseTempC: round(this.temps.case + noise(0.18)),
        ambientTempC: this.temps.ambient
      },
      fans: this.fans.map((fan) => ({ ...fan }))
    };
  }

  fanByRole(role) {
    return this.fans.find((fan) => fan.role === role) || this.fans[0];
  }
}

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

class FanOptimizer {
  constructor() {
    this.mode = "idle";
    this.samples = [];
    this.scenarios = {
      cpu: new Map(),
      gpu: new Map(),
      system: new Map()
    };
    this.targets = {
      cpuTempC: 78,
      gpuTempC: 82,
      caseTempC: 46
    };
  }

  start() {
    this.mode = "optimizing";
  }

  stop() {
    this.mode = "idle";
  }

  recommend(telemetry, loadState) {
    const previous = this.samples.at(-1);
    const sample = {
      ...telemetry,
      loadMode: loadState.mode,
      slopes: previous ? slopes(previous, telemetry) : { cpu: 0, gpu: 0, case: 0 }
    };
    this.samples.push(sample);
    if (this.samples.length > 900) this.samples.shift();

    const recommendations = telemetry.fans.filter(isOptimized).map((fan) => {
      const sourceTemp = fan.role === "cpu"
        ? telemetry.sensors.cpuTempC
        : Math.max(telemetry.sensors.caseTempC + 12, telemetry.sensors.cpuTempC - 10, telemetry.sensors.gpuTempC - 8);
      const slope = fan.role === "cpu" ? sample.slopes.cpu : Math.max(sample.slopes.case, sample.slopes.gpu * 0.5);
      const target = fan.role === "cpu" ? this.targets.cpuTempC : this.targets.caseTempC + 12;
      const base = curvePwm(sourceTemp, defaultCurve(fan.role));
      const heatPenalty = clamp((sourceTemp - target + 8) * 2.7, -12, 30);
      const slopePenalty = clamp(slope * 85, -8, 22);
      const nextPwm = clamp(base + heatPenalty + slopePenalty, fan.minPwm, fan.maxPwm);
      const steppedPwm = clamp(fan.pwm + clamp(nextPwm - fan.pwm, -6, 8), fan.minPwm, fan.maxPwm);

      if (loadState.mode !== "idle") {
        this.captureScenarioPoint(loadState.mode, fan.id, sourceTemp, steppedPwm);
      }

      return { fanId: fan.id, pwm: Math.round(steppedPwm) };
    });

    return recommendations;
  }

  captureScenarioPoint(mode, fanId, temp, pwm) {
    const scenario = this.scenarios[mode];
    if (!scenario) return;

    const bucket = Math.round(temp / 5) * 5;
    const key = `${fanId}:${bucket}`;
    const existing = scenario.get(key);
    const next = existing ? Math.max(existing, pwm) : pwm;
    scenario.set(key, Math.round(next));
  }

  buildProfile(fans) {
    const generatedAt = new Date().toISOString();
    const fanProfiles = fans.filter(isOptimized).map((fan) => ({
      id: fan.id,
      label: fan.label,
      role: fan.role,
      minPwm: fan.minPwm,
      maxPwm: fan.maxPwm,
      curve: mergeCurves(fan, this.scenarios)
    }));

    return {
      schemaVersion: 1,
      generatedAt,
      adapter: {
        preferred: "pawnio",
        fallback: "browser-sim",
        bridgeEndpoint: "http://127.0.0.1:9876"
      },
      optimizer: {
        objective: "keep CPU, GPU-influenced case temperature, and case sensors under target with lowest stable PWM",
        targets: this.targets,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        scenarios: ["cpu", "gpu", "system"]
      },
      fans: fanProfiles,
      rawScenarioPoints: serializeScenarioPoints(this.scenarios)
    };
  }
}

function defaultCurve(role) {
  if (role === "cpu") {
    return [
      { tempC: 30, pwm: 22 },
      { tempC: 45, pwm: 32 },
      { tempC: 60, pwm: 52 },
      { tempC: 75, pwm: 78 },
      { tempC: 88, pwm: 100 }
    ];
  }

  return [
    { tempC: 28, pwm: 20 },
    { tempC: 38, pwm: 30 },
    { tempC: 48, pwm: 48 },
    { tempC: 62, pwm: 72 },
    { tempC: 76, pwm: 100 }
  ];
}

function mergeCurves(fan, scenarios) {
  const base = defaultCurve(fan.role);
  const temps = [...new Set([...base.map((point) => point.tempC), 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85])].sort((a, b) => a - b);
  let last = fan.minPwm;

  return temps.map((tempC) => {
    const learned = ["cpu", "gpu", "system"].map((mode) => {
      const points = scenarios[mode];
      return points.get(`${fan.id}:${Math.round(tempC / 5) * 5}`) ?? 0;
    });
    const pwm = clamp(Math.max(curvePwm(tempC, base), ...learned, last), fan.minPwm, fan.maxPwm);
    last = pwm;
    return { tempC, pwm: Math.round(pwm) };
  });
}

function curvePwm(temp, curve) {
  if (temp <= curve[0].tempC) return curve[0].pwm;
  for (let index = 1; index < curve.length; index += 1) {
    const left = curve[index - 1];
    const right = curve[index];
    if (temp <= right.tempC) {
      const t = (temp - left.tempC) / (right.tempC - left.tempC);
      return left.pwm + (right.pwm - left.pwm) * t;
    }
  }
  return curve.at(-1).pwm;
}

function serializeScenarioPoints(scenarios) {
  const output = {};
  for (const [mode, points] of Object.entries(scenarios)) {
    output[mode] = [...points.entries()].map(([key, pwm]) => {
      const [fanId, tempC] = key.split(":");
      return { fanId, tempC: Number(tempC), pwm };
    });
  }
  return output;
}

function slopes(previous, current) {
  const seconds = Math.max(0.1, (Date.parse(current.timestamp) - Date.parse(previous.timestamp)) / 1000);
  return {
    cpu: (current.sensors.cpuTempC - previous.sensors.cpuTempC) / seconds,
    gpu: (current.sensors.gpuTempC - previous.sensors.gpuTempC) / seconds,
    case: (current.sensors.caseTempC - previous.sensors.caseTempC) / seconds
  };
}

function average(values, fallback) {
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function noise(range) {
  return (Math.random() - 0.5) * range;
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

const loadController = new LoadController(elements.gpuCanvas);
const optimizer = new FanOptimizer();
const adapter = await initializeAdapter();
let telemetry = await adapter.readTelemetry(loadController.getState());
let profile = loadProfile() || optimizer.buildProfile(telemetry.fans);

renderAll();

setInterval(async () => {
  if (detecting) return; // the sweep owns the fans while it runs
  telemetry = await adapter.readTelemetry(loadController.getState());

  if (optimizer.mode === "optimizing") {
    const recommendations = optimizer.recommend(telemetry, loadController.getState());
    await Promise.all(recommendations.map((item) => adapter.setFanPwm(item.fanId, item.pwm)));
    telemetry = await adapter.readTelemetry(loadController.getState());
  }

  profile = optimizer.buildProfile(telemetry.fans);
  saveProfile(profile);
  renderAll();
}, SAMPLE_INTERVAL_MS);

elements.startOptimizer.addEventListener("click", () => {
  optimizer.start();
  renderAll();
});

elements.stopAll.addEventListener("click", async () => {
  optimizer.stop();
  loadController.stop();
  for (const fan of telemetry.fans) {
    await adapter.setFanPwm(fan.id, Math.max(fan.minPwm, 30));
  }
  renderAll();
});

elements.exportProfile.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `fan-profile-${new Date().toISOString().replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
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
      } else if (fan.role === "ignore") {
        // A header that clearly has a fan shouldn't stay ignored; default it to a
        // system fan and let the user reassign CPU if appropriate.
        await adapter.updateFan(fan.id, { role: "case" });
      }
    }
  } finally {
    detecting = false;
    elements.autoDetect.disabled = false;
    telemetry = await adapter.readTelemetry(loadController.getState());
    renderAll();
  }
}

document.querySelectorAll("[data-load]").forEach((button) => {
  button.addEventListener("click", () => {
    loadController.start(button.dataset.load);
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
  elements.cpuTemp.textContent = telemetry ? telemetry.sensors.cpuTempC.toFixed(1) : "--";
  elements.gpuTemp.textContent = telemetry ? telemetry.sensors.gpuTempC.toFixed(1) : "--";
  elements.caseTemp.textContent = telemetry ? telemetry.sensors.caseTempC.toFixed(1) : "--";
  elements.optimizerMode.textContent = optimizer.mode === "optimizing" ? "Optimizing" : "Idle";
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
    meta.innerHTML = `<span>${fan.source ?? "?"}</span><span>${fan.pwm}% PWM</span><span>${fan.rpm} RPM</span><span>${fan.controllable === false ? "read-only" : fan.id}</span>`;

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
      item.textContent = `${point.tempC}C: ${point.pwm}%`;
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
