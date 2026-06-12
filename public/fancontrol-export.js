// Builds a FanControl (Rem0o/FanControl) compatible configuration from an optimized
// profile. Modeled on a real FanControl v269 config export.

const FC_VERSION = "269";

// Bridge identifiers keep LHM's board index segment (/lpc/nct6799d/0/control/1) but
// FanControl's LPC identifiers omit it (/lpc/nct6799d/control/1). Other hardware
// (amdcpu, gpu-nvidia, ...) keeps its index.
export function toFanControlIdentifier(identifier) {
  if (!identifier) return null;
  return identifier.replace(/^\/lpc\/([^/]+)\/\d+\//, "/lpc/$1/");
}

const hysteresis = (responseTime) => ({
  ResponseTimeUp: responseTime,
  ResponseTimeDown: responseTime,
  HysteresisValueUp: 2,
  HysteresisValueDown: 2,
  IgnoreHysteresisAtLimits: true
});

// Which time-averaged custom sensor a fan's curve should follow.
function curveSourceFor(fan, sources) {
  if (fan.role === "gpu" && sources.gpu) return sources.gpu;
  if (fan.fanType === "gpu_intake" && sources.gpu) return sources.gpu;
  // cpu coolers, cpu intake, and exhaust follow the CPU average; FanControl mix
  // curves can be layered on by the user later if they want multi-source exhaust.
  return sources.cpu ?? sources.gpu;
}

export function buildFanControlConfig(profile, allFans, sensorIdentifiers) {
  const sources = {};
  const customSensors = [];

  if (sensorIdentifiers?.cpu) {
    sources.cpu = "Time/AFT CPU Average";
    customSensors.push({
      SelectedTempSource: { Identifier: sensorIdentifiers.cpu },
      NickName: "AFT CPU Average",
      Identifier: sources.cpu,
      IsHidden: false,
      SelectedTime: 10
    });
  }
  if (sensorIdentifiers?.gpu) {
    sources.gpu = "Time/AFT GPU Average";
    customSensors.push({
      SelectedTempSource: { Identifier: sensorIdentifiers.gpu },
      NickName: "AFT GPU Average",
      Identifier: sources.gpu,
      IsHidden: false,
      SelectedTime: 10
    });
  }

  const usedNames = new Set();
  const curveNameFor = (label) => {
    let name = `AFT ${label}`;
    let suffix = 2;
    while (usedNames.has(name)) name = `AFT ${label} (${suffix++})`;
    usedNames.add(name);
    return name;
  };

  const profiledById = new Map(profile.fans.map((fan) => [fan.id, fan]));
  const curveNames = new Map();
  const fanCurves = [];

  for (const fan of profile.fans) {
    const name = curveNameFor(fan.label);
    curveNames.set(fan.id, name);
    fanCurves.push({
      Name: name,
      IsHidden: false,
      CommandMode: 0, // percent PWM
      SelectedTempSource: { Identifier: curveSourceFor(fan, sources) },
      Points: fan.curve.map((point) => `${point.tempC},${point.pwm}`),
      MaximumTemperature: 120,
      MinimumTemperature: 20,
      MaximumCommand: 100,
      HysteresisConfig: hysteresis(fan.fanType === "aio" ? 3 : 1)
    });
  }

  const controls = allFans.map((fan) => {
    const profiled = profiledById.get(fan.id);
    return {
      NickName: fan.label,
      Identifier: toFanControlIdentifier(fan.identifier) ?? fan.id,
      IsHidden: !profiled,
      Enable: Boolean(profiled),
      SelectedFanCurve: profiled ? { Name: curveNames.get(fan.id) } : null,
      SelectedOffset: 0,
      PairedFanSensor: fan.rpmIdentifier
        ? { Identifier: toFanControlIdentifier(fan.rpmIdentifier) }
        : null,
      SelectedStart: 0,
      SelectedStop: 0,
      MinimumPercent: profiled ? profiled.minPwm : 0,
      SelectedCommandStepUp: profiled?.fanType === "aio" ? 2 : 3,
      SelectedCommandStepDown: 2,
      ManualControlValue: 50,
      ManualControl: false,
      ForceApply: false,
      Calibration: []
    };
  });

  const fanSensors = allFans
    .filter((fan) => fan.rpmIdentifier)
    .map((fan) => ({
      Identifier: toFanControlIdentifier(fan.rpmIdentifier),
      IsHidden: false,
      NickName: fan.label
    }));

  return {
    __VERSION__: FC_VERSION,
    FanControl: {
      Controls: controls,
      CustomSensors: customSensors,
      FanCurves: fanCurves,
      FanSensors: fanSensors,
      TemperatureSensors: []
    },
    Sensors: {
      AdlxWrapperSettings: { Enabled: false },
      DisabledPlugins: [],
      DisableStorageSensors: true,
      LibreHardwareMonitorSettings: {
        Controller: false,
        CPU: true,
        EmbeddedEC: false,
        GPU: true,
        Memory: false,
        Motherboard: true,
        PowerMonitor: false,
        PSU: false,
        Storage: false,
        StorageUpdateInterval: "00:01:00",
        ZeroRPMOverride: false
      },
      // FanControl needs its NvAPI wrapper enabled to drive GPU fan controls.
      NvAPIWrapperSettings: { Enabled: profile.fans.some((fan) => fan.role === "gpu"), ZeroRPMOverride: false }
    },
    MainWindow: {
      Fahrenheit: false,
      HideCalibration: false,
      HideFanSpeedCards: true,
      HorizontalUIOrientation: false,
      PrimaryColor: "#FF607D8B",
      SecondaryColor: "#FFAEEA00",
      SelectedTheme: "",
      ShowHiddenCards: false,
      SyncThemeWithWindows: true,
      SyncTrayIconColorWithWindows: true,
      TrayIconColor: null,
      TrayIcons: []
    }
  };
}
