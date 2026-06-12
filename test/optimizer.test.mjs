// End-to-end optimizer verification against the thermal simulator.
// Run with: npm test
//
// Simulates the browser's 1 Hz loop (sample -> recommend -> apply PWM) under a full
// CPU load and asserts that the optimizer (a) keeps temperatures under control,
// (b) records learned scenario points, (c) produces monotonic curves that reflect
// the learned data, and (d) survives a serialize/hydrate round trip (page reload).

import assert from "node:assert/strict";
import { FanOptimizer, isOptimized } from "../public/optimizer.js";
import { BrowserSimAdapter } from "../public/sim-adapter.js";

const ITERATIONS = 600; // ≈ 60 simulated seconds (sim clamps dt to >= 0.1 s)
const loadState = { mode: "cpu", cpu: true, gpu: false };

const adapter = new BrowserSimAdapter();
const optimizer = new FanOptimizer();
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
assert.ok(cpuFan.pwm > 50, `CPU fan should have ramped under load, got ${cpuFan.pwm}%`);
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

console.log("optimizer test passed");
console.log(`  peak CPU temp: ${peakCpu.toFixed(1)}°C (target ${optimizer.targets.cpuTempC}°C)`);
console.log(`  final CPU fan: ${cpuFan.pwm}% PWM`);
console.log(`  learned points: cpu=${counts.cpu} gpu=${counts.gpu} system=${counts.system}`);
