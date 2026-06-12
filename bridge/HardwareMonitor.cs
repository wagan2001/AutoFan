using System.Text.Json;
using LibreHardwareMonitor.Hardware;

namespace FanBridge;

// Owns the LibreHardwareMonitor Computer object and translates its sensor tree into
// the flat telemetry/fan shape the browser app expects (mirrors BrowserSimAdapter).
internal sealed class HardwareMonitor
{
    private readonly object _gate = new();
    private readonly Computer _computer;
    private readonly UpdateVisitor _visitor = new();

    // Stable bridge id -> the live control + paired fan sensor for a channel.
    private readonly Dictionary<string, FanChannel> _channels = new();
    private readonly Dictionary<string, FanConfigEntry> _config;

    // Last software-commanded PWM per fan. Some BIOS/EC implementations re-arm their
    // own smart-fan control periodically, silently overriding a one-time register
    // write — exactly what must not happen mid heat-soak. A timer re-asserts every
    // held value so the command sticks regardless of what the firmware does and
    // independent of the UI's polling cadence.
    private readonly Dictionary<string, float> _held = new();
    private System.Threading.Timer? _holdTimer;
    private static readonly TimeSpan HoldInterval = TimeSpan.FromSeconds(2);

    private ISensor? _cpuTemp;
    private ISensor? _gpuTemp;
    private ISensor? _caseTemp;

    public HardwareMonitor()
    {
        _computer = new Computer
        {
            IsMotherboardEnabled = true,
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsControllerEnabled = true
        };
        _computer.Open();
        _computer.Accept(_visitor);

        _config = FanConfigStore.Load();
        MapHardware();
        FanConfigStore.Save(_config); // persist any defaults we just filled in

        _holdTimer = new System.Threading.Timer(_ => EnforceHolds(), null, HoldInterval, HoldInterval);
    }

    // Re-write every held PWM value to the hardware so firmware smart-fan re-arming
    // cannot silently take the fans back (e.g. mid heat-soak). Cheap register writes;
    // runs on its own timer so it does not depend on the UI polling.
    private void EnforceHolds()
    {
        lock (_gate)
        {
            foreach (var (id, value) in _held)
            {
                if (!_channels.TryGetValue(id, out var channel)) continue;
                try { channel.Control?.Control?.SetSoftware(value); }
                catch { /* transient hardware hiccup; next tick retries */ }
            }
        }
    }

    // Walk the hardware tree once and cache the sensors we care about.
    private void MapHardware()
    {
        var temps = new List<ISensor>();
        var fanSensors = new List<ISensor>();
        var controls = new List<ISensor>();

        void Walk(IHardware hw)
        {
            foreach (var s in hw.Sensors)
            {
                switch (s.SensorType)
                {
                    case SensorType.Temperature: temps.Add(s); break;
                    case SensorType.Fan: fanSensors.Add(s); break;
                    case SensorType.Control: controls.Add(s); break;
                }
            }
            foreach (var sub in hw.SubHardware) Walk(sub);
        }

        foreach (var hw in _computer.Hardware) Walk(hw);

        _cpuTemp = PickTemp(temps, HardwareType.Cpu, "package", "tctl", "tdie", "core");
        _gpuTemp = PickTemp(temps, HardwareType.GpuNvidia, "core", "hot")
                   ?? PickTemp(temps, HardwareType.GpuAmd, "core", "hot")
                   ?? PickTemp(temps, HardwareType.GpuIntel, "core", "hot");
        // "Case" temp: a motherboard/Super I/O temperature that is not the CPU's.
        _caseTemp = temps.FirstOrDefault(t =>
                        (t.Hardware.HardwareType == HardwareType.Motherboard ||
                         t.Hardware.HardwareType == HardwareType.SuperIO) && t != _cpuTemp)
                    ?? temps.FirstOrDefault(t => t != _cpuTemp && t != _gpuTemp);

        // Pair fan (RPM) and control (PWM) sensors that belong to the same channel.
        // On Super I/O chips, the fan and its control share the same hardware + index.
        foreach (var control in controls)
        {
            var fan = fanSensors.FirstOrDefault(f => f.Hardware == control.Hardware && f.Index == control.Index);
            Register(control.Identifier.ToString(), fan, control);
        }

        // Read-only fans that have no matching control (still worth reporting).
        foreach (var fan in fanSensors)
        {
            if (controls.Any(c => c.Hardware == fan.Hardware && c.Index == fan.Index)) continue;
            Register(fan.Identifier.ToString(), fan, null);
        }
    }

    private void Register(string identifier, ISensor? fan, ISensor? control)
    {
        var id = Sanitize(identifier);
        var hardware = control?.Hardware ?? fan?.Hardware;
        var source = SourceOf(hardware);
        var rawName = control?.Name ?? fan?.Name ?? id;
        if (!_config.TryGetValue(id, out var cfg))
        {
            // GPU fans default to the "gpu" role (controlled, following the GPU
            // temperature target). Users can set any fan to "ignore" to leave it
            // on firmware control.
            var role = source == "gpu" ? "gpu" : "case";
            cfg = new FanConfigEntry
            {
                Label = rawName,
                Role = role,
                FanType = DefaultFanType(role),
                MinPwm = 0,
                MaxPwm = 100
            };
            _config[id] = cfg;
        }
        _channels[id] = new FanChannel(id, fan, control, cfg, source);
    }

    internal static string DefaultFanType(string role) => role switch
    {
        "cpu" => "air",
        "case" => "exhaust",
        "gpu" => "gpu",
        _ => ""
    };

    // Classify where a fan channel lives so the UI/optimizer can treat GPU fans
    // (out of scope) differently from motherboard/EC fans.
    private static string SourceOf(IHardware? hardware) => hardware?.HardwareType switch
    {
        HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel => "gpu",
        HardwareType.Motherboard or HardwareType.SuperIO => "motherboard",
        HardwareType.EmbeddedController => "ec",
        _ => hardware?.HardwareType.ToString().ToLowerInvariant() ?? "unknown"
    };

    private static ISensor? PickTemp(IEnumerable<ISensor> temps, HardwareType type, params string[] prefer)
    {
        var pool = temps.Where(t => t.Hardware.HardwareType == type).ToList();
        foreach (var key in prefer)
        {
            var hit = pool.FirstOrDefault(t => t.Name.Contains(key, StringComparison.OrdinalIgnoreCase));
            if (hit != null) return hit;
        }
        return pool.FirstOrDefault();
    }

    private static string Sanitize(string identifier) =>
        identifier.Trim('/').Replace('/', '-');

    private void Refresh()
    {
        // Update() must be called on each hardware to pull fresh values.
        _computer.Accept(_visitor);
    }

    public object Capabilities()
    {
        lock (_gate)
        {
            Refresh();
            return new
            {
                adapter = "PawnIO bridge (LibreHardwareMonitor)",
                capabilities = new[] { "readSensors", "setFanPwm", "labelFans" },
                sensorIdentifiers = new
                {
                    cpu = _cpuTemp?.Identifier.ToString(),
                    gpu = _gpuTemp?.Identifier.ToString(),
                    @case = _caseTemp?.Identifier.ToString()
                },
                fans = _channels.Values.Select(c => c.ToView()).ToArray()
            };
        }
    }

    public object Telemetry()
    {
        lock (_gate)
        {
            Refresh();
            // The browser optimizer does arithmetic on these and assumes numbers, so
            // coalesce missing sensors (e.g. no discrete GPU, no board temp) to the CPU
            // temperature rather than emitting null. ambient is unused downstream.
            var cpu = _cpuTemp?.Value ?? 40f;
            return new
            {
                timestamp = DateTime.UtcNow.ToString("o"),
                sensors = new
                {
                    cpuTempC = Round(cpu),
                    gpuTempC = Round(_gpuTemp?.Value ?? cpu),
                    caseTempC = Round(_caseTemp?.Value ?? cpu),
                    ambientTempC = (double?)null
                },
                fans = _channels.Values.Select(c => c.ToView()).ToArray()
            };
        }
    }

    public bool SetPwm(string id, double pwm)
    {
        lock (_gate)
        {
            if (!_channels.TryGetValue(id, out var channel) || channel.Control?.Control == null)
                return false;

            var value = (float)Math.Clamp(pwm, 0, 100);
            channel.Control.Control.SetSoftware(value);
            _held[id] = value; // keep re-asserting until released (see EnforceHolds)
            return true;
        }
    }

    public bool UpdateConfig(string id, FanConfigPatch patch)
    {
        lock (_gate)
        {
            if (!_config.TryGetValue(id, out var cfg)) return false;
            if (!string.IsNullOrWhiteSpace(patch.Label)) cfg.Label = patch.Label.Trim();
            if (!string.IsNullOrWhiteSpace(patch.Role))
            {
                cfg.Role = patch.Role.Trim();
                // Keep the fan type coherent when the role changes and no explicit
                // type was supplied alongside it.
                if (string.IsNullOrWhiteSpace(patch.FanType)) cfg.FanType = DefaultFanType(cfg.Role);
            }
            if (patch.FanType != null) cfg.FanType = patch.FanType.Trim();
            if (patch.MinPwm is { } min) cfg.MinPwm = (int)Math.Clamp(min, 0, 100);
            if (patch.MaxPwm is { } max) cfg.MaxPwm = (int)Math.Clamp(max, 0, 100);
            FanConfigStore.Save(_config);
            return true;
        }
    }

    public Snapshot Snapshot()
    {
        lock (_gate) return new Snapshot(_channels.Values.ToList());
    }

    // Hand every controllable fan back to BIOS/automatic control. Safe to call repeatedly.
    public void RestoreDefaults()
    {
        lock (_gate)
        {
            try { _holdTimer?.Dispose(); } catch { /* already disposed */ }
            _holdTimer = null;
            _held.Clear();
            foreach (var channel in _channels.Values)
            {
                try { channel.Control?.Control?.SetDefault(); } catch { /* best effort */ }
            }
            try { _computer.Close(); } catch { /* already closed */ }
        }
    }

    // Full hardware/sensor tree — used by GET /debug and the startup printout so you
    // can see exactly what LibreHardwareMonitor detects (e.g. whether the motherboard
    // Super I/O exposes any Fan/Control channels for the CPU header).
    public object Discovery()
    {
        lock (_gate)
        {
            Refresh();
            return new { hardware = _computer.Hardware.Select(Describe).ToArray() };
        }
    }

    private object Describe(IHardware hw) => new
    {
        name = hw.Name,
        type = hw.HardwareType.ToString(),
        identifier = hw.Identifier.ToString(),
        sensors = hw.Sensors
            .Where(s => s.SensorType is SensorType.Temperature or SensorType.Fan or SensorType.Control)
            .OrderBy(s => s.SensorType).ThenBy(s => s.Index)
            .Select(s => new
            {
                type = s.SensorType.ToString(),
                name = s.Name,
                index = s.Index,
                value = Round(s.Value),
                controllable = s.Control != null
            })
            .ToArray(),
        subHardware = hw.SubHardware.Select(Describe).ToArray()
    };

    // LibreHardwareMonitor's own diagnostic report: includes the kernel driver load
    // status and the LPC/Super I/O chip-detection probe results — the authoritative
    // place to see *why* motherboard fans were (not) found.
    public string Report()
    {
        lock (_gate) return _computer.GetReport();
    }

    // Human-readable version of Discovery() for the console at startup.
    public void PrintTree()
    {
        lock (_gate)
        {
            Refresh();
            Console.WriteLine("--- Detected hardware ---");
            foreach (var hw in _computer.Hardware) PrintHardware(hw, 0);
            Console.WriteLine("-------------------------");
        }
    }

    private static void PrintHardware(IHardware hw, int depth)
    {
        var pad = new string(' ', depth * 2);
        Console.WriteLine($"{pad}[{hw.HardwareType}] {hw.Name}");
        foreach (var s in hw.Sensors
                     .Where(s => s.SensorType is SensorType.Temperature or SensorType.Fan or SensorType.Control)
                     .OrderBy(s => s.SensorType).ThenBy(s => s.Index))
        {
            var ctl = s.Control != null ? " (controllable)" : "";
            var val = s.Value is { } v ? v.ToString("0.#") : "--";
            Console.WriteLine($"{pad}  {s.SensorType} #{s.Index} \"{s.Name}\" = {val}{ctl}");
        }
        foreach (var sub in hw.SubHardware) PrintHardware(sub, depth + 1);
    }

    private static double? Round(float? value) =>
        value is { } v ? Math.Round(v, 1) : null;
}

internal sealed record Snapshot(IReadOnlyList<FanChannel> Fans);

internal sealed class FanChannel
{
    public string Id { get; }
    public ISensor? Fan { get; }
    public ISensor? Control { get; }
    public FanConfigEntry Config { get; }
    public string Source { get; }

    public FanChannel(string id, ISensor? fan, ISensor? control, FanConfigEntry config, string source)
    {
        Id = id;
        Fan = fan;
        Control = control;
        Config = config;
        Source = source;
    }

    public bool Controllable => Control?.Control != null;

    // Shape matches the browser BrowserSimAdapter fan object. Raw LHM identifiers are
    // included so exports (e.g. FanControl configs) can reference the real hardware.
    public object ToView() => new
    {
        id = Id,
        label = Config.Label,
        role = Config.Role,
        fanType = Config.FanType,
        source = Source,
        identifier = (Control ?? Fan)?.Identifier.ToString(),
        rpmIdentifier = Fan?.Identifier.ToString(),
        pwm = Control?.Value is { } p ? (int)Math.Round(p) : 0,
        rpm = Fan?.Value is { } r ? (int)Math.Round(r) : 0,
        minPwm = Config.MinPwm,
        maxPwm = Config.MaxPwm,
        controllable = Controllable
    };
}

// Visits each hardware/subhardware and calls Update() so sensor values are current.
internal sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);

    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (var sub in hardware.SubHardware) sub.Accept(this);
    }

    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}
