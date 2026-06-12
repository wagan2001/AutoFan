# Automatic Fan Tuner

Early prototype for an automatic fan curve optimizer. It runs as a local browser app so the CPU worker and WebGL GPU stress tests can operate without native dependencies while the hardware control layer is still being shaped.

## Run

```powershell
npm start
```

Open `http://localhost:4173`.

```powershell
npm test   # simulated end-to-end optimizer verification (no hardware needed)
```

## What Works Now

- Synthetic CPU load through Web Workers.
- Synthetic GPU load through a WebGL fragment shader.
- CPU, GPU, and combined system load modes.
- Calibration controls for detected fans with 0%, 35%, and 100% test commands.
- Fan labeling and CPU/system role assignment.
- Real-time optimizer loop that samples telemetry, adjusts PWM, and records scenario points.
- Universal JSON profile generation by merging CPU, GPU, and system scenario curves.
- Local profile persistence through browser storage and JSON export — learned scenario
  points are rehydrated on reload, so optimization progress survives page refreshes.
- Live optimizer activity log and learned-point counters, so you can watch every PWM
  decision and confirm scenario data is being captured.
- Auto-detect sweep that finds which fan headers actually have fans connected.
- One-click **Auto-Optimize**: runs CPU → GPU → full-system scenarios automatically,
  each with a heat-soak phase (load on, nothing recorded until temperatures flatten),
  a measurement phase, and a cooldown — with a progress bar, time-remaining estimate,
  and a safety cutoff that ramps fans to 100% if the CPU approaches its limit.
- Detailed fan types that shape the optimization: CPU coolers are Air or AIO (AIO
  control is damped to account for coolant thermal lag); case fans are CPU intake,
  GPU intake, or Exhaust (each follows the temperature source it actually serves).
- Algorithmic universal-curve combination: per-scenario curves merge through a
  weighted power mean (per-fan-type scenario relevance weights, smoothing, monotonic
  enforcement) instead of a naive max.
- Custom CPU temperature target with Ryzen (85°C) and Intel (90°C) presets.
- **Export FanControl**: generates a config compatible with Rem0o's FanControl
  (controls, per-fan curves bound to time-averaged temp sensors, paired RPM sensors),
  so optimized curves can run under FanControl directly.

## Hardware Boundary

The browser app talks to hardware through an adapter. `BrowserSimAdapter` simulates
fans and thermal response (the default in a plain dev session). `PawnIoAdapter` calls a
local **FanBridge** service over HTTP:

- `GET /capabilities`
- `GET /telemetry`
- `PUT /fans/:fanId/pwm` with `{ "pwm": 55 }`
- `PUT /fans/:fanId/config` with `{ "label": "...", "role": "cpu|case", "minPwm": 0, "maxPwm": 100 }`

`FanBridge` (in [`bridge/`](bridge/)) is a .NET 8 console service that wraps
`LibreHardwareMonitorLib`. LibreHardwareMonitor's ring-0 access is provided by the
**PawnIO** driver and it ships the Super I/O chip drivers (ITE, Nuvoton, …) needed to
read temperatures/RPMs and write fan PWM — so this is the PawnIO path, with the
chip-level work already done. GPU fan control is deliberately out of scope for the first
version; GPU temperature only informs system (case) fan curves.

### Running against real hardware (Windows)

1. Install the **PawnIO** driver (see the PawnIO / Fan Control documentation).
2. Build and run the bridge **as administrator** (driver load requires elevation):
   ```powershell
   cd bridge
   dotnet run
   ```
   It listens on `http://127.0.0.1:9876` and prints the detected fan channels.
3. In another terminal, start the web app and open the PawnIO entry point:
   ```powershell
   npm start
   ```
   Open `http://localhost:4173/?adapter=pawnio`. The status line shows the bridge
   connected with N controllable fans. (Plain `http://localhost:4173` tries the bridge
   first and falls back to the simulator; `?adapter=sim` forces simulation.)

**Calibration:** use a fan's **100% / 0%** buttons to spin a physical fan up/down so you
can identify it, then set its label and role. Labels/roles persist to
`bridge/fan-config.json` (keyed by the hardware channel) across restarts.

**Safety:** the bridge restores BIOS/automatic fan control (`SetDefault`) on exit,
Ctrl+C, or crash, so fans are never left stuck at a software value. Some boards lock fan
control in the EC and expose no writable control channel — those fans appear in
`/capabilities` with `controllable: false`.

## Profile Shape

Profiles are generated in the UI and exported as JSON:

```json
{
  "schemaVersion": 1,
  "adapter": {
    "preferred": "pawnio",
    "fallback": "browser-sim"
  },
  "optimizer": {
    "scenarios": ["cpu", "gpu", "system"]
  },
  "fans": [
    {
      "id": "cpu_cooler",
      "label": "CPU cooler",
      "role": "cpu",
      "curve": [
        { "tempC": 30, "pwm": 22 }
      ]
    }
  ]
}
```

## FanControl Notes

FanControl's old open-source history is useful as design precedent for sensor/control abstractions and mixed-source curves, but this prototype does not vendor or copy FanControl code. The adapter boundary is intentionally narrow so references from old discussions can inform driver integration without tying the optimizer to one implementation.
