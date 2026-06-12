// Core optimizer logic, extracted from the UI so it can run in Node tests as well
// as the browser.

export const SAMPLE_INTERVAL_MS = 1000;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const round = (value, places = 1) => Number(value.toFixed(places));

// Only motherboard/EC fans are optimization targets. GPU fans (and anything the user
// marks "ignore") are left to BIOS control, matching the project's scope.
const OPTIMIZED_ROLES = new Set(["cpu", "case"]);
export const isOptimized = (fan) => OPTIMIZED_ROLES.has(fan.role);

// Detailed fan types per role. The type changes which temperature the fan reacts to
// and how aggressively it is stepped.
export const FAN_TYPES = {
  cpu: [
    { value: "air", label: "Air cooler" },
    { value: "aio", label: "AIO (liquid)" }
  ],
  case: [
    { value: "cpu_intake", label: "CPU intake" },
    { value: "gpu_intake", label: "GPU intake" },
    { value: "exhaust", label: "Exhaust" }
  ]
};

export const defaultFanType = (role) => (role === "cpu" ? "air" : role === "case" ? "exhaust" : "");

export const CPU_TARGET_PRESETS = {
  ryzen: 85,
  intel: 90
};

// Step dynamics per fan type. AIO loops have large coolant thermal mass: the sensor
// lags the heat, so chasing short-term slope just causes oscillation — damp it.
const TYPE_DYNAMICS = {
  air: { slopeGain: 85, stepUp: 8, stepDown: 6 },
  aio: { slopeGain: 40, stepUp: 5, stepDown: 3 },
  cpu_intake: { slopeGain: 85, stepUp: 8, stepDown: 6 },
  gpu_intake: { slopeGain: 85, stepUp: 8, stepDown: 6 },
  exhaust: { slopeGain: 85, stepUp: 8, stepDown: 6 }
};

// How much each load scenario's learned points matter per fan type when combining
// into the universal curve. A GPU intake cares about the gpu scenario; a CPU cooler
// barely cares about pure-gpu load, and the full-system scenario matters to everyone.
const SCENARIO_WEIGHTS = {
  air: { cpu: 1.0, gpu: 0.25, system: 1.0 },
  aio: { cpu: 1.0, gpu: 0.25, system: 1.0 },
  cpu_intake: { cpu: 0.9, gpu: 0.35, system: 1.0 },
  gpu_intake: { cpu: 0.25, gpu: 1.0, system: 1.0 },
  exhaust: { cpu: 0.8, gpu: 0.8, system: 1.0 }
};

// Exponent of the weighted power mean used to combine scenario curves. Higher values
// approach a hard max; 4 biases strongly toward the most demanding scenario while
// still letting corroborating scenarios and weights shape the result.
const COMBINE_EXPONENT = 4;

const fanTypeOf = (fan) => fan.fanType || defaultFanType(fan.role);

export class FanOptimizer {
  constructor() {
    this.mode = "idle";
    this.samples = [];
    // When false, recommend() still drives fans but does not record scenario points.
    // The auto-optimization routine disables capture during heat soak so only
    // steady-state (heat-soaked) behavior ends up in the curves.
    this.captureEnabled = true;
    this.scenarios = {
      cpu: new Map(),
      gpu: new Map(),
      system: new Map()
    };
    this.targets = {
      cpuTempC: 85,
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

  setCpuTarget(tempC) {
    this.targets.cpuTempC = clamp(Math.round(tempC), 60, 95);
    return this.targets.cpuTempC;
  }

  // Restore previously learned scenario points (exported as rawScenarioPoints) so a
  // page reload does not silently discard everything the optimizer learned.
  hydrate(rawScenarioPoints) {
    for (const [mode, points] of Object.entries(rawScenarioPoints || {})) {
      const scenario = this.scenarios[mode];
      if (!scenario || !Array.isArray(points)) continue;
      for (const point of points) {
        const key = `${point.fanId}:${point.tempC}`;
        const existing = scenario.get(key) ?? 0;
        scenario.set(key, Math.max(existing, Math.round(point.pwm)));
      }
    }
  }

  scenarioCounts() {
    return {
      cpu: this.scenarios.cpu.size,
      gpu: this.scenarios.gpu.size,
      system: this.scenarios.system.size
    };
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
      const type = fanTypeOf(fan);
      const dynamics = TYPE_DYNAMICS[type] ?? TYPE_DYNAMICS.exhaust;
      const sourceTemp = sourceTempFor(fan, type, telemetry.sensors);
      const slope = slopeFor(fan, type, sample.slopes);
      const target = fan.role === "cpu" ? this.targets.cpuTempC : this.targets.caseTempC + 12;
      const base = curvePwm(sourceTemp, defaultCurve(fan.role));
      const heatPenalty = clamp((sourceTemp - target + 8) * 2.7, -12, 30);
      const slopePenalty = clamp(slope * dynamics.slopeGain, -8, 22);
      const nextPwm = clamp(base + heatPenalty + slopePenalty, fan.minPwm, fan.maxPwm);
      const steppedPwm = clamp(
        fan.pwm + clamp(nextPwm - fan.pwm, -dynamics.stepDown, dynamics.stepUp),
        fan.minPwm,
        fan.maxPwm
      );

      if (this.captureEnabled && loadState.mode !== "idle") {
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
      fanType: fanTypeOf(fan),
      identifier: fan.identifier ?? null,
      rpmIdentifier: fan.rpmIdentifier ?? null,
      minPwm: fan.minPwm,
      maxPwm: fan.maxPwm,
      curve: combineScenarioCurves(fan, this.scenarios)
    }));

    return {
      schemaVersion: 2,
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
        scenarios: ["cpu", "gpu", "system"],
        combine: `weighted power mean (p=${COMBINE_EXPONENT}) with per-fan-type scenario weights, smoothed and monotonic`
      },
      fans: fanProfiles,
      rawScenarioPoints: serializeScenarioPoints(this.scenarios)
    };
  }
}

function sourceTempFor(fan, type, sensors) {
  if (fan.role === "cpu") return sensors.cpuTempC;
  if (type === "cpu_intake") return Math.max(sensors.caseTempC + 12, sensors.cpuTempC - 8);
  if (type === "gpu_intake") return Math.max(sensors.caseTempC + 12, sensors.gpuTempC - 6);
  return Math.max(sensors.caseTempC + 12, sensors.cpuTempC - 10, sensors.gpuTempC - 8);
}

function slopeFor(fan, type, sampleSlopes) {
  if (fan.role === "cpu") return sampleSlopes.cpu;
  if (type === "cpu_intake") return Math.max(sampleSlopes.case, sampleSlopes.cpu * 0.6);
  if (type === "gpu_intake") return Math.max(sampleSlopes.case, sampleSlopes.gpu * 0.7);
  return Math.max(sampleSlopes.case, sampleSlopes.gpu * 0.5, sampleSlopes.cpu * 0.4);
}

export function defaultCurve(role) {
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

// Combine the per-scenario learned curves into one universal curve.
//
// Instead of a naive max across scenarios, each temperature bucket is combined with a
// weighted power mean: the default curve participates with weight 1 and each scenario
// that visited the bucket participates with a per-fan-type weight. The exponent biases
// the result toward the most demanding scenario (safety) while corroboration and
// relevance weights still shape it (efficiency: an irrelevant scenario can't fully
// dictate a fan's curve). The result is smoothed, floored at the default curve, and
// forced monotonic.
export function combineScenarioCurves(fan, scenarios) {
  const base = defaultCurve(fan.role);
  const weights = SCENARIO_WEIGHTS[fanTypeOf(fan)] ?? SCENARIO_WEIGHTS.exhaust;
  const temps = [...new Set([...base.map((point) => point.tempC), 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85])].sort((a, b) => a - b);

  const raw = temps.map((tempC) => {
    const basePwm = curvePwm(tempC, base);
    const bucketKey = `${fan.id}:${Math.round(tempC / 5) * 5}`;
    let numerator = Math.pow(basePwm, COMBINE_EXPONENT);
    let denominator = 1;
    for (const mode of ["cpu", "gpu", "system"]) {
      const learned = scenarios[mode].get(bucketKey);
      if (learned === undefined) continue;
      const weight = weights[mode];
      numerator += weight * Math.pow(learned, COMBINE_EXPONENT);
      denominator += weight;
    }
    const combined = Math.pow(numerator / denominator, 1 / COMBINE_EXPONENT);
    return Math.max(basePwm, combined);
  });

  // Light 3-point smoothing to remove single-bucket spikes from noisy samples.
  const smoothed = raw.map((value, index) =>
    index === 0 || index === raw.length - 1
      ? value
      : raw[index - 1] * 0.25 + value * 0.5 + raw[index + 1] * 0.25
  );

  let last = fan.minPwm;
  return temps.map((tempC, index) => {
    const pwm = clamp(Math.max(smoothed[index], last), fan.minPwm, fan.maxPwm);
    last = pwm;
    return { tempC, pwm: Math.round(pwm) };
  });
}

export function curvePwm(temp, curve) {
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

export function serializeScenarioPoints(scenarios) {
  const output = {};
  for (const [mode, points] of Object.entries(scenarios)) {
    output[mode] = [...points.entries()].map(([key, pwm]) => {
      const splitAt = key.lastIndexOf(":");
      return { fanId: key.slice(0, splitAt), tempC: Number(key.slice(splitAt + 1)), pwm };
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
