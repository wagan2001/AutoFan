// End-to-end optimizer verification against the thermal simulator.
// Run with: npm test
//
// Simulates the browser's 1 Hz loop (sample -> recommend -> apply PWM) under a full
// CPU load and asserts that the optimizer (a) keeps temperatures under control,
// (b) records learned scenario points, (c) produces monotonic curves that reflect
// the learned data, and (d) survives a serialize/hydrate round trip (page reload).

import assert from "node:assert/strict";
import { FanOptimizer, isOptimized, combineScenarioCurves, CPU_TARGET_PRESETS } from "../public/optimizer.js";
import { BrowserSimAdapter } from "../public/sim-adapter.js";
import { buildFanControlConfig, toFanControlIdentifier } from "../public/fancontrol-export.js";

const ITERATIONS = 600; // ≈ 60 simulated seconds (sim clamps dt to >= 0.1 s)
const loadState = { mode: "cpu", cpu: true, gpu: false };

const adapter = new BrowserSimAdapter();
const optimizer = new FanOptimizer();
optimizer.setCpuTarget(78); // pin the target so assertions are independent of the default
optimizer.start();

let telemetry = await adapter.readTelemetry(loadState);
let peakCpu = 0;

for (let i = 0; i < ITERATIONS; i += 1) {
  const recommendations = optimizer.recommend(telemetry, loadState);

  assert.ok(recommendations.length > 0, "optimizer should manage at least one fan");
  for (const item of recommendations) {
    assert.ok(Number.isFinite(item.pwm), `PWM must be a finite number, got ${item.pwm}`);
    assert.ok(item.pwm >= 0 && item.pwm <= 100, `PWM out of range: ${item.pwm}`);
    await adapter.setFanPwm(item.fanId, item.pwm);
  }

  telemetry = await adapter.readTelemetry(loadState);
  peakCpu = Math.max(peakCpu, telemetry.sensors.cpuTempC);
}

// 1. The optimizer never targets ignored/GPU fans.
const managedIds = new Set(optimizer.recommend(telemetry, loadState).map((item) => item.fanId));
for (const fan of telemetry.fans) {
  assert.equal(
    managedIds.has(fan.id),
    isOptimized(fan),
    `fan ${fan.id} (${fan.role}) ${isOptimized(fan) ? "should" : "should not"} be managed`
  );
}

// 2. Under sustained full CPU load the loop ramps fans: the CPU fan must be well above
// its idle duty and the temperature held below the throttle-ish region of the sim.
const cpuFan = telemetry.fans.find((fan) => fan.role === "cpu");
assert.ok(cpuFan.pwm > 45, `CPU fan should have ramped well above its 35% idle under load, got ${cpuFan.pwm}%`);
assert.ok(peakCpu < 95, `simulated CPU should stay under 95°C, peaked at ${peakCpu}`);

// 3. Scenario points were learned for the active load mode.
const counts = optimizer.scenarioCounts();
assert.ok(counts.cpu > 0, "cpu scenario should have learned points");
assert.equal(counts.gpu, 0, "gpu scenario should be empty (no gpu load was run)");

// 4. The exported profile embeds the learned data and every curve is monotonic.
const profile = optimizer.buildProfile(telemetry.fans);
assert.ok(profile.rawScenarioPoints.cpu.length > 0, "profile must serialize learned points");
assert.ok(profile.fans.every((fan) => fan.role !== "ignore"), "ignored fans must not be profiled");
for (const fan of profile.fans) {
  for (let i = 1; i < fan.curve.length; i += 1) {
    assert.ok(fan.curve[i].pwm >= fan.curve[i - 1].pwm, `${fan.label} curve must be monotonic`);
    assert.ok(fan.curve[i].tempC > fan.curve[i - 1].tempC, `${fan.label} temps must increase`);
  }
}

// The learned cpu points must actually lift the curve above the default at the
// temperatures the load test visited.
const learnedMax = Math.max(...profile.rawScenarioPoints.cpu.map((point) => point.pwm));
assert.ok(learnedMax > 40, `learned points should reflect ramped PWM, max was ${learnedMax}`);

// 5. Reload survival: hydrating a fresh optimizer from the serialized points must
// reproduce the same learned data (this was the bug that produced empty exports).
const reloaded = new FanOptimizer();
reloaded.hydrate(profile.rawScenarioPoints);
assert.deepEqual(reloaded.scenarioCounts(), counts, "hydrate must restore all scenario points");
const reloadedProfile = reloaded.buildProfile(telemetry.fans);
assert.deepEqual(
  reloadedProfile.rawScenarioPoints,
  profile.rawScenarioPoints,
  "serialize -> hydrate -> serialize must round-trip"
);

// 6. Capture gate: with captureEnabled=false (heat-soak phase) the optimizer still
// drives fans but records nothing.
{
  const gated = new FanOptimizer();
  gated.captureEnabled = false;
  const recs = gated.recommend(telemetry, loadState);
  assert.ok(recs.length > 0, "gated optimizer still recommends PWM");
  const gatedCounts = gated.scenarioCounts();
  assert.equal(gatedCounts.cpu + gatedCounts.gpu + gatedCounts.system, 0,
    "no scenario points may be captured while capture is disabled");
}

// 7. CPU target presets and clamping.
{
  const t = new FanOptimizer();
  assert.equal(t.setCpuTarget(CPU_TARGET_PRESETS.ryzen), 85);
  assert.equal(t.setCpuTarget(CPU_TARGET_PRESETS.intel), 90);
  assert.equal(t.setCpuTarget(200), 95, "target must clamp to a safe ceiling");
  assert.equal(t.setCpuTarget(10), 60, "target must clamp to a sensible floor");
}

// 8. AIO damping: an AIO CPU fan must step more gently than an air cooler under the
// same hot, fast-rising conditions.
{
  const makeTelemetry = (fanType, timestamp, cpuTempC) => ({
    timestamp,
    sensors: { cpuTempC, gpuTempC: 50, caseTempC: 35, ambientTempC: 23 },
    fans: [{ id: "f", label: "f", role: "cpu", fanType, pwm: 30, minPwm: 0, maxPwm: 100 }]
  });
  const step = (fanType) => {
    const opt = new FanOptimizer();
    opt.recommend(makeTelemetry(fanType, "2026-01-01T00:00:00Z", 70), { mode: "cpu" });
    const [rec] = opt.recommend(makeTelemetry(fanType, "2026-01-01T00:00:01Z", 74), { mode: "cpu" });
    return rec.pwm - 30;
  };
  assert.ok(step("aio") < step("air"), `AIO step (${step("aio")}) must be smaller than air step (${step("air")})`);
}

// 9. Algorithmic combination: scenario weights must matter. The same learned GPU
// scenario point lifts a gpu_intake fan's curve more than a cpu cooler's curve.
{
  const scenarios = { cpu: new Map(), gpu: new Map(), system: new Map() };
  scenarios.gpu.set("f:60", 95); // gpu scenario demanded 95% at 60°C
  const fanOf = (role, fanType) => ({ id: "f", label: "f", role, fanType, minPwm: 0, maxPwm: 100 });

  const at60 = (curve) => curve.find((point) => point.tempC === 60).pwm;
  const gpuIntake = at60(combineScenarioCurves(fanOf("case", "gpu_intake"), scenarios));
  const cpuCooler = at60(combineScenarioCurves(fanOf("cpu", "air"), scenarios));
  assert.ok(gpuIntake > cpuCooler,
    `gpu scenario must lift gpu_intake (${gpuIntake}) more than a cpu cooler (${cpuCooler})`);

  // And the soft combination must sit between the base curve and the raw demand —
  // not naively snap to the max.
  assert.ok(gpuIntake < 95, `combined value (${gpuIntake}) must stay below the naive max (95)`);
  assert.ok(gpuIntake > 70, `combined value (${gpuIntake}) must move well above the base curve`);
}

// 10. FanControl export: identifier mapping, curve points format, enabled flags.
{
  const fcProfile = optimizer.buildProfile(telemetry.fans);
  const config = buildFanControlConfig(fcProfile, telemetry.fans, {
    cpu: "/amdcpu/0/temperature/2",
    gpu: "/gpu-nvidia/0/temperature/0"
  });

  assert.equal(config.__VERSION__, "269");
  assert.equal(toFanControlIdentifier("/lpc/nct6799d/0/control/1"), "/lpc/nct6799d/control/1");
  assert.equal(toFanControlIdentifier("/amdcpu/0/temperature/2"), "/amdcpu/0/temperature/2");

  const enabled = config.FanControl.Controls.filter((control) => control.Enable);
  assert.equal(enabled.length, fcProfile.fans.length, "every optimized fan gets an enabled control");
  const gpuControl = config.FanControl.Controls.find((control) => control.NickName === "GPU fan");
  assert.ok(gpuControl && gpuControl.Enable && !gpuControl.IsHidden, "GPU fan must be exported enabled (GPU control is on)");
  assert.equal(config.Sensors.NvAPIWrapperSettings.Enabled, true, "NvAPI wrapper must be enabled for GPU fan control");
  const gpuCurveName = gpuControl.SelectedFanCurve.Name;
  const gpuCurve = config.FanControl.FanCurves.find((curve) => curve.Name === gpuCurveName);
  assert.equal(gpuCurve.SelectedTempSource.Identifier, "Time/AFT GPU Average", "GPU fan curve must follow the GPU sensor");

  assert.equal(config.FanControl.FanCurves.length, fcProfile.fans.length);
  for (const curve of config.FanControl.FanCurves) {
    assert.ok(curve.Points.every((point) => /^\d+,\d+$/.test(point)), "points must be 'temp,pwm' strings");
    assert.ok(curve.SelectedTempSource.Identifier.startsWith("Time/AFT"), "curves must follow the averaged custom sensors");
  }
  assert.equal(config.FanControl.CustomSensors.length, 2, "cpu + gpu averaged sensors expected");
}

// 11. Hold controller: under full CPU load it should ride the CPU at the target
// temperature (heat soak), not cool maximally.
{
  const sim = new BrowserSimAdapter();
  const opt = new FanOptimizer();
  opt.setCpuTarget(78);
  const load = { mode: "cpu", cpu: true, gpu: false };
  let tel = await sim.readTelemetry(load);
  opt.beginHold(tel);

  const errors = [];
  for (let i = 0; i < 900; i += 1) {
    opt.observe(tel, load);
    const recs = opt.holdTick(tel, "cpu");
    for (const rec of recs) await sim.setFanPwm(rec.fanId, rec.pwm);
    tel = await sim.readTelemetry(load);
    errors.push(opt.holdError(tel, "cpu"));
  }

  const tail = errors.slice(-200);
  const meanError = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  assert.ok(Math.min(...errors) <= 3, "hold should reach the target band at some point");
  assert.ok(meanError <= 5, `hold should ride near target (mean tail error ${meanError.toFixed(2)}°)`);
  assert.ok(Math.max(...tail) < 95 - 78, "hold must stay within safe range of target");
}

// 12. Dissipation staircase data: a calibrated curve must be quiet at the target when
// measurements show diminishing returns, and still reach 100% above the target.
{
  const opt = new FanOptimizer();
  opt.setCpuTarget(85);
  const fan = { id: "f", label: "CPU cooler", role: "cpu", fanType: "air", pwm: 50, minPwm: 0, maxPwm: 100 };
  // Typical thermally-dense CPU: more airflow barely lowers the steady temperature.
  for (const [pwm, temp] of [[35, 85], [45, 82], [55, 80], [65, 79], [75, 78.5], [85, 78.2], [100, 78]]) {
    opt.recordDissipation("cpu", fan.id, pwm, temp);
  }

  const profile = opt.buildProfile([fan]);
  const curve = profile.fans[0].curve;
  const pwmAt = (t) => curve.find((point) => point.tempC === t).pwm;

  assert.ok(pwmAt(85) <= 55,
    `calibrated curve should be quiet at target (got ${pwmAt(85)}%) — measured dissipation says 35% holds 85°`);
  assert.equal(pwmAt(95), 100, "curve must reach 100% above the target");
  assert.ok(pwmAt(50) < pwmAt(75), "curve must still ramp with temperature");
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i].pwm >= curve[i - 1].pwm, "calibrated curve must be monotonic");
  }

  // Round-trip: dissipation data survives serialize -> hydrate (page reload).
  const reloaded = new FanOptimizer();
  reloaded.hydrateDissipation(profile.dissipation);
  assert.equal(reloaded.dissipation.cpu.length, 7, "dissipation measurements must round-trip");
  assert.deepEqual(reloaded.buildProfile([fan]).fans[0].curve, curve, "rehydrated curve must match");
}

// 13. GPU role: gpu fans are optimized, follow the GPU temperature, and respect the
// GPU target.
{
  const opt = new FanOptimizer();
  assert.equal(opt.setGpuTarget(80), 80);
  assert.equal(opt.setGpuTarget(150), 90, "gpu target must clamp");
  const gpuFan = { id: "g", label: "GPU fan", role: "gpu", fanType: "gpu", pwm: 30, minPwm: 0, maxPwm: 100 };
  assert.ok(isOptimized(gpuFan), "gpu role must be optimized");
  assert.equal(opt.targetForFan(gpuFan), opt.targets.gpuTempC);
}

console.log("optimizer test passed");
console.log(`  peak CPU temp: ${peakCpu.toFixed(1)}°C (target ${optimizer.targets.cpuTempC}°C)`);
console.log(`  final CPU fan: ${cpuFan.pwm}% PWM`);
console.log(`  learned points: cpu=${counts.cpu} gpu=${counts.gpu} system=${counts.system}`);
