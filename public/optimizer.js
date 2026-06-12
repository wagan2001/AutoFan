// Core optimizer logic, extracted from the UI so it can run in Node tests as well
// as the browser.

export const SAMPLE_INTERVAL_MS = 1000;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const round = (value, places = 1) => Number(value.toFixed(places));

// Only motherboard/EC fans are optimization targets. GPU fans (and anything the user
// marks "ignore") are left to BIOS control, matching the project's scope.
const OPTIMIZED_ROLES = new Set(["cpu", "case"]);
export const isOptimized = (fan) => OPTIMIZED_ROLES.has(fan.role);

export class FanOptimizer {
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

export function mergeCurves(fan, scenarios) {
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
