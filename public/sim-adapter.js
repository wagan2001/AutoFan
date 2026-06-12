import { clamp, round } from "./optimizer.js";

// Simulated fans + first-order thermal response. Used in the browser when no
// hardware bridge is reachable, and in Node tests to verify the optimizer loop.
export class BrowserSimAdapter {
  constructor() {
    this.name = "Browser simulation adapter";
    this.lastUpdate = performance.now();
    this.fans = [
      { id: "cpu_cooler", label: "CPU cooler", role: "cpu", fanType: "air", source: "motherboard", identifier: "/lpc/sim/0/control/0", rpmIdentifier: "/lpc/sim/0/fan/0", pwm: 35, rpm: 850, minPwm: 20, maxPwm: 100 },
      { id: "case_intake", label: "Case intake", role: "case", fanType: "cpu_intake", source: "motherboard", identifier: "/lpc/sim/0/control/1", rpmIdentifier: "/lpc/sim/0/fan/1", pwm: 30, rpm: 620, minPwm: 18, maxPwm: 100 },
      { id: "case_exhaust", label: "Case exhaust", role: "case", fanType: "exhaust", source: "motherboard", identifier: "/lpc/sim/0/control/2", rpmIdentifier: "/lpc/sim/0/fan/2", pwm: 30, rpm: 650, minPwm: 18, maxPwm: 100 },
      { id: "gpu_fan", label: "GPU fan", role: "ignore", fanType: "", source: "gpu", identifier: "/gpu-nvidia/0/control/1", rpmIdentifier: "/gpu-nvidia/0/fan/1", pwm: 40, rpm: 1100, minPwm: 0, maxPwm: 100 }
    ];
    this.temps = { cpu: 36, gpu: 34, case: 31, ambient: 23 };
  }

  async connect() {
    return {
      adapter: this.name,
      fans: this.fans.map((fan) => ({ ...fan })),
      capabilities: ["readSensors", "setFanPwm", "syntheticTelemetry"],
      sensorIdentifiers: {
        cpu: "/amdcpu/0/temperature/2",
        gpu: "/gpu-nvidia/0/temperature/0",
        case: "/lpc/sim/0/temperature/1"
      }
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

function average(values, fallback) {
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function noise(range) {
  return (Math.random() - 0.5) * range;
}
