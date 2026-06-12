# Automatic Fan Tuner

Early prototype for an automatic fan curve optimizer. It runs as a local browser app so the CPU worker and WebGL GPU stress tests can operate without native dependencies while the hardware control layer is still being shaped.

## Run

```powershell
npm start
```

Open `http://localhost:4173`.

## What Works Now

- Synthetic CPU load through Web Workers.
- Synthetic GPU load through a WebGL fragment shader.
- CPU, GPU, and combined system load modes.
- Calibration controls for detected fans with 0%, 35%, and 100% test commands.
- Fan labeling and CPU/system role assignment.
- Real-time optimizer loop that samples telemetry, adjusts PWM, and records scenario points.
- Universal JSON profile generation by merging CPU, GPU, and system scenario curves.
- Local profile persistence through browser storage and JSON export.

## Hardware Boundary

The app currently uses `BrowserSimAdapter`, which simulates controllable fans and thermal response. `PawnIoAdapter` is stubbed behind the same interface and expects a future local bridge:

- `GET /capabilities`
- `GET /telemetry`
- `PUT /fans/:fanId/pwm` with `{ "pwm": 55 }`

That bridge is the intended place for PawnIO, LibreHardwareMonitor, OpenHardwareMonitor, WinRing0-style IO, or another privileged Windows driver path. GPU fan control is deliberately out of scope for the first version; GPU load only informs system fan curves.

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
