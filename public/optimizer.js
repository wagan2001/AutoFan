// Core optimizer logic, extracted from the UI so it can run in Node tests as well
// as the browser.

export const SAMPLE_INTERVAL_MS = 1000;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const round = (value, places = 1) => Number(value.toFixed(places));

// Motherboard/EC fans and GPU fans are optimization targets; anything marked
// "ignore" stays on BIOS/firmware control.
const OPTIMIZED_ROLES = new Set(["cpu", "case", "gpu"]);
export const isOptimized = (fan) => OPTIMIZED_ROLES.has(fan.role);

// Detailed fan types per role. The type changes which temperature the fan reacts to
// and how aggressively it is stepped. GPU fans have a single implicit type.
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

export const defaultFanType = (role) =>
  role === "cpu" ? "air" : role === "case" ? "exhaust" : role === "gpu" ? "gpu" : "";

export const CPU_TARGET_PRESETS = {
  ryzen: 85,
  intel: 90
};

// Step dynamics per fan type. AIO loops have large coolant thermal mass: the sensor
// lags the heat, so chasing short-term slope just causes oscillation — damp it.
const TYPE_DYNAMICS = {
  air: { slopeGain: 85, stepUp: 8, stepDown: 6 },
  aio: { slopeGain: 40, stepUp: 5, stepDown: 3 },
  gpu: { slopeGain: 75, stepUp: 8, stepDown: 6 },
  cpu_intake: { slopeGain: 85, stepUp: 8, stepDown: 6 },
  gpu_intake: { slopeGain: 85, stepUp: 8, stepDown: 6 },
  exhaust: { slopeGain: 85, stepUp: 8, stepDown: 6 }
};

// How much each load scenario's learned data matters per fan type when combining
// into the universal curve. A GPU intake cares about the gpu scenario; a CPU cooler
// barely cares about pure-gpu load, and the full-system scenario matters to everyone.
const SCENARIO_WEIGHTS = {
  air: { cpu: 1.0, gpu: 0.25, system: 1.0 },
  aio: { cpu: 1.0, gpu: 0.25, system: 1.0 },
  gpu: { cpu: 0.2, gpu: 1.0, system: 1.0 },
  cpu_intake: { cpu: 0.9, gpu: 0.35, system: 1.0 },
  gpu_intake: { cpu: 0.25, gpu: 1.0, system: 1.0 },
  exhaust: { cpu: 0.8, gpu: 0.8, system: 1.0 }
};

// Exponent of the weighted power mean used to combine scenario curves. Higher values
// approach a hard max; 4 biases strongly toward the most demanding scenario while
// still letting corroborating scenarios and weights shape the result.
const COMBINE_EXPONENT = 4;

// Which fan groups a scenario actively drives toward their temperature target
// during the hold (heat-soak) phase and the dissipation staircase.
export const scenarioHoldGroups = (mode) =>
  mode === "cpu" ? ["cpu"] : mode === "gpu" ? ["gpu"] : mode === "system" ? ["cpu", "gpu"] : [];

// PWM used for assisting/idle fans while another group is being held or measured.
export const HOLD_ASSIST_PWM = 30;

const fanTypeOf = (fan) => fan.fanType || defaultFanType(fan.role);

// The temperature a fan's curve is driven by (its "source" temperature).
export function sourceTempForFan(fan, sensors) {
  if (fan.role === "cpu") return sensors.cpuTempC;
  if (fan.role === "gpu") return sensors.gpuTempC;
  const type = fanTypeOf(fan);
  if (type === "cpu_intake") return Math.max(sensors.caseTempC + 12, sensors.cpuTempC - 8);
  if (type === "gpu_intake") return Math.max(sensors.caseTempC + 12, sensors.gpuTempC - 6);
  return Math.max(sensors.caseTempC + 12, sensors.cpuTempC - 10, sensors.gpuTempC - 8);
}

export class FanOptimizer {
  constructor() {
    this.mode = "idle";
    this.samples = [];
    // When false, recommend() still drives fans but does not record scenario points.
    this.captureEnabled = true;
    // Per-second observations: temp-bucket -> max PWM seen (coarse safety floor).
    this.scenarios = {
      cpu: new Map(),
      gpu: new Map(),
      system: new Map()
    };
    // Calibrated dissipation measurements from the staircase phase:
    // mode -> [{ fanId, pwm, tempC }] where tempC is the steady source temperature
    // reached while the fan group held that PWM under full scenario load.
    this.dissipation = {
      cpu: [],
      gpu: [],
      system: []
    };
    this.targets = {
      cpuTempC: 85,
      gpuTempC: 80,
      caseTempC: 46
    };
    // Hold-controller state: group name -> commanded PWM.
    this._hold = {};
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

  setGpuTarget(tempC) {
    this.targets.gpuTempC = clamp(Math.round(tempC), 60, 90);
    return this.targets.gpuTempC;
  }

  targetForFan(fan) {
    if (fan.role === "cpu") return this.targets.cpuTempC;
    if (fan.role === "gpu") return this.targets.gpuTempC;
    return this.targets.caseTempC + 12;
  }

  // Record a telemetry sample and compute temperature slopes. Shared by the
  // heuristic recommend() and the hold controller so samples stay continuous.
  observe(telemetry, loadState) {
    const previous = this.samples.at(-1);
    const sample = {
      ...telemetry,
      loadMode: loadState.mode,
      slopes: previous ? slopes(previous, telemetry) : { cpu: 0, gpu: 0, case: 0 }
    };
    this.samples.push(sample);
    if (this.samples.length > 1800) this.samples.shift();
    return sample;
  }

  recommend(telemetry, loadState) {
    const sample = this.observe(telemetry, loadState);

    const recommendations = telemetry.fans.filter(isOptimized).map((fan) => {
      const type = fanTypeOf(fan);
      const dynamics = TYPE_DYNAMICS[type] ?? TYPE_DYNAMICS.exhaust;
      const sourceTemp = sourceTempForFan(fan, telemetry.sensors);
      const slope = slopeFor(fan, type, sample.slopes);
      const target = this.targetForFan(fan);
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

  // ----- Heat-soak hold controller -------------------------------------------------
  //
  // During heat soak the goal is to sit AT the target temperature so heat saturates
  // the heatpipes/fins/coolant — not to cool as hard as possible. A per-group
  // integrating controller trims PWM each tick: too hot -> more airflow, below
  // target -> less, letting the component climb to and then ride the target.

  beginHold(telemetry) {
    this._hold = {};
    for (const fan of telemetry.fans.filter(isOptimized)) {
      if (!(fan.role in this._hold)) this._hold[fan.role] = fan.pwm;
    }
  }

  holdTick(telemetry, mode) {
    // Samples are recorded by the app's telemetry loop; compute slopes against the
    // latest one without pushing (avoids double-rate history during hold).
    const previous = this.samples.at(-1);
    const sample = { slopes: previous ? slopes(previous, telemetry) : { cpu: 0, gpu: 0, case: 0 } };
    const driven = scenarioHoldGroups(mode);

    return telemetry.fans.filter(isOptimized).map((fan) => {
      const group = fan.role;
      if (group === "case" || !driven.includes(group)) {
        // Assist fans run quiet and constant so they don't fight the measurement.
        return { fanId: fan.id, pwm: clamp(HOLD_ASSIST_PWM, fan.minPwm, fan.maxPwm) };
      }

      const temp = group === "cpu" ? telemetry.sensors.cpuTempC : telemetry.sensors.gpuTempC;
      const target = group === "cpu" ? this.targets.cpuTempC : this.targets.gpuTempC;
      const slope = group === "cpu" ? sample.slopes.cpu : sample.slopes.gpu;
      const error = temp - target;

      const current = this._hold[group] ?? fan.pwm;
      const adjust = clamp(error * 1.6 + slope * 50, -4, 6);
      const next = clamp(current + adjust, Math.max(fan.minPwm, 15), 100);
      this._hold[group] = next;
      return { fanId: fan.id, pwm: Math.round(next) };
    });
  }

  // Worst-case |temp - target| across the groups a scenario holds.
  holdError(telemetry, mode) {
    const errors = scenarioHoldGroups(mode).map((group) => {
      const temp = group === "cpu" ? telemetry.sensors.cpuTempC : telemetry.sensors.gpuTempC;
      const target = group === "cpu" ? this.targets.cpuTempC : this.targets.gpuTempC;
      return Math.abs(temp - target);
    });
    return errors.length ? Math.max(...errors) : 0;
  }

  holdPwm(group) {
    return this._hold[group];
  }

  // ----- Dissipation measurements ---------------------------------------------------

  recordDissipation(mode, fanId, pwm, tempC) {
    const list = this.dissipation[mode];
    if (!list) return;
    list.push({ fanId, pwm: Math.round(pwm), tempC: round(tempC) });
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

  scenarioCounts() {
    const d = this.dissipation;
    return {
      cpu: this.scenarios.cpu.size + d.cpu.length,
      gpu: this.scenarios.gpu.size + d.gpu.length,
      system: this.scenarios.system.size + d.system.length
    };
  }

  // Restore previously learned data (observations + dissipation measurements) so a
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

  hydrateDissipation(dissipation) {
    for (const [mode, entries] of Object.entries(dissipation || {})) {
      const list = this.dissipation[mode];
      if (!list || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        list.push({ fanId: entry.fanId, pwm: entry.pwm, tempC: entry.tempC });
      }
    }
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
      curve: this.curveForFan(fan)
    }));

    return {
      schemaVersion: 3,
      generatedAt,
      adapter: {
        preferred: "pawnio",
        fallback: "browser-sim",
        bridgeEndpoint: "http://127.0.0.1:9876"
      },
      optimizer: {
        objective: "hold CPU/GPU at their temperature targets with the lowest PWM the measured dissipation allows",
        targets: this.targets,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        scenarios: ["cpu", "gpu", "system"],
        combine: `calibrated dissipation curves per scenario, weighted power mean (p=${COMBINE_EXPONENT}), smoothed and monotonic`
      },
      fans: fanProfiles,
      rawScenarioPoints: serializeScenarioPoints(this.scenarios),
      dissipation: this.dissipation
    };
  }

  // Calibrated curve when dissipation measurements exist for the fan; otherwise the
  // observation-based combination.
  curveForFan(fan) {
    const modesWithData = ["cpu", "gpu", "system"].filter((mode) =>
      this.dissipation[mode].some((entry) => entry.fanId === fan.id)
    );
    if (!modesWithData.length) return combineScenarioCurves(fan, this.scenarios);

    const weights = SCENARIO_WEIGHTS[fanTypeOf(fan)] ?? SCENARIO_WEIGHTS.exhaust;
    const target = this.targetForFan(fan);
    const temps = curveTempGrid(fan.role);

    const perMode = modesWithData.map((mode) => ({
      weight: weights[mode],
      curve: dissipationCurve(
        fan,
        this.dissipation[mode].filter((entry) => entry.fanId === fan.id),
        target
      )
    }));

    const raw = temps.map((tempC, index) => {
      let numerator = 0;
      let denominator = 0;
      for (const { weight, curve } of perMode) {
        numerator += weight * Math.pow(curve[index], COMBINE_EXPONENT);
        denominator += weight;
      }
      return Math.pow(numerator / denominator, 1 / COMBINE_EXPONENT);
    });

    return finishCurve(fan, temps, raw);
  }
}

// Temperature grid used by all generated curves. Extends to 95°C so the ramp to
// 100% above any target (up to target+8) always lands on the grid.
function curveTempGrid(role) {
  const base = defaultCurve(role).map((point) => point.tempC);
  return [...new Set([...base, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95])].sort((a, b) => a - b);
}

// Build one scenario's calibrated curve for a fan from its dissipation measurements,
// evaluated on the role's temperature grid (returns PWM values aligned to the grid).
//
// The measurements are (pwm, steady source temp) pairs taken under full scenario
// load: higher PWM -> lower steady temperature. The curve is anchored at the
// temperature target with the lowest PWM that was measured to hold it:
//   - below target: a gentle ease-in ramp from the quiet floor (no reason to spend
//     noise holding temperatures we are happy to let rise),
//   - at target: the calibrated anchor PWM,
//   - above target: ramp to 100% quickly — and immediately if even 100% PWM could
//     not pull the component down to target (no headroom measured).
export function dissipationCurve(fan, entries, target) {
  const temps = curveTempGrid(fan.role);
  const sorted = [...entries].sort((a, b) => a.pwm - b.pwm);
  const floor = Math.max(fan.minPwm, curvePwm(38, defaultCurve(fan.role)));

  // PWM needed to hold the target, interpolated from measurements. Temperatures
  // decrease as PWM rises, so walk for the bracketing pair.
  const hottest = sorted[0];
  const coolest = sorted.at(-1);
  let anchor;
  if (target >= hottest.tempC) {
    // Even the quietest measured level held at/below target.
    anchor = hottest.pwm;
  } else if (target <= coolest.tempC) {
    // Even flat out the component sits above target.
    anchor = 100;
  } else {
    anchor = 100;
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1]; // lower pwm, hotter
      const b = sorted[i]; // higher pwm, cooler
      if (target <= a.tempC && target >= b.tempC) {
        const t = a.tempC === b.tempC ? 0 : (a.tempC - target) / (a.tempC - b.tempC);
        anchor = a.pwm + (b.pwm - a.pwm) * t;
        break;
      }
    }
  }
  anchor = clamp(anchor, floor, 100);

  // If max cooling still couldn't reach the target, 100% must arrive at the target
  // itself; otherwise leave a small band of headroom above it.
  const fullPwmTemp = coolest.tempC;
  const hundredAt = fullPwmTemp > target ? target + 2 : target + 8;

  const rampStart = 40;
  return temps.map((tempC) => {
    if (tempC <= rampStart) return floor;
    if (tempC < target) {
      const t = (tempC - rampStart) / (target - rampStart);
      return floor + (anchor - floor) * Math.pow(t, 1.6);
    }
    if (tempC >= hundredAt) return 100;
    const t = (tempC - target) / (hundredAt - target);
    return anchor + (100 - anchor) * t;
  });
}

// Smooth, clamp, and enforce monotonicity on a raw curve aligned to the grid.
function finishCurve(fan, temps, raw) {
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

function slopeFor(fan, type, sampleSlopes) {
  if (fan.role === "cpu") return sampleSlopes.cpu;
  if (fan.role === "gpu") return sampleSlopes.gpu;
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

  if (role === "gpu") {
    return [
      { tempC: 30, pwm: 25 },
      { tempC: 45, pwm: 32 },
      { tempC: 60, pwm: 45 },
      { tempC: 70, pwm: 62 },
      { tempC: 78, pwm: 82 },
      { tempC: 84, pwm: 100 }
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

// Observation-based combination (used until calibrated dissipation data exists).
export function combineScenarioCurves(fan, scenarios) {
  const base = defaultCurve(fan.role);
  const weights = SCENARIO_WEIGHTS[fanTypeOf(fan)] ?? SCENARIO_WEIGHTS.exhaust;
  const temps = curveTempGrid(fan.role);

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

  return finishCurve(fan, temps, raw);
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
