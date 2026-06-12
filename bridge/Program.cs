using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LibreHardwareMonitor.Hardware;

namespace FanBridge;

// FanBridge: a local, elevated HTTP service that exposes real motherboard sensors
// and fan control to the Automatic Fan Tuner browser app. It wraps
// LibreHardwareMonitorLib, whose ring-0 access is provided by the PawnIO driver and
// which already ships the Super I/O chip drivers (ITE, Nuvoton, ...) needed to read
// temperatures/RPMs and write fan PWM.
//
// It implements exactly the contract the browser's PawnIoAdapter already calls:
//   GET  /capabilities
//   GET  /telemetry
//   PUT  /fans/{id}/pwm     body { "pwm": 55 }
//   PUT  /fans/{id}/config  body { "label": "...", "role": "cpu|case", "minPwm": 0, "maxPwm": 100 }
internal static class Program
{
    private const string Prefix = "http://127.0.0.1:9876/";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static HardwareMonitor _monitor = null!;

    private static int Main()
    {
        Console.WriteLine("FanBridge starting (LibreHardwareMonitor + PawnIO)...");

        try
        {
            _monitor = new HardwareMonitor();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Failed to initialize hardware monitor: {ex.Message}");
            Console.Error.WriteLine("Ensure you are running as administrator and the PawnIO driver is installed.");
            return 1;
        }

        // Safety: always hand fans back to BIOS control when we exit, however we exit.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => _monitor.RestoreDefaults();
        AppDomain.CurrentDomain.UnhandledException += (_, _) => _monitor.RestoreDefaults();
        Console.CancelKeyPress += (_, e) =>
        {
            Console.WriteLine("\nShutting down, restoring BIOS fan control...");
            _monitor.RestoreDefaults();
            // Let the runtime continue to ProcessExit for a clean stop.
            e.Cancel = false;
        };

        _monitor.PrintTree();

        var fans = _monitor.Snapshot().Fans;
        Console.WriteLine($"Detected {fans.Count} fan channel(s): " +
                          string.Join(", ", fans.Select(f => $"{f.Config.Label}[{f.Source}{(f.Controllable ? ",ctl" : "")}]")));
        var optimizable = fans.Count(f => f.Source != "gpu" && f.Controllable);
        Console.WriteLine($"{optimizable} motherboard/EC fan(s) available to optimize " +
                          "(GPU fans default to 'ignore' / BIOS control).");
        // Always dump LHM's diagnostic report next to the exe so we can see driver /
        // Super I/O detection status even when nothing was found.
        var reportPath = Path.Combine(AppContext.BaseDirectory, "lhm-report.txt");
        try
        {
            File.WriteAllText(reportPath, _monitor.Report());
            Console.WriteLine($"Wrote LibreHardwareMonitor diagnostic report to {reportPath}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Could not write LHM report: {ex.Message}");
        }

        if (optimizable == 0)
        {
            Console.WriteLine("NOTE: no controllable motherboard fans found.");
            if (fans.All(f => f.Source == "gpu"))
                Console.WriteLine(
                    "The motherboard Super I/O was not detected. If the CPU temperature above also reads 0,\n" +
                    "the low-level driver likely did not load. Most common fixes on Windows 11:\n" +
                    "  1. Windows Security > Device security > Core isolation > turn OFF Memory integrity, reboot.\n" +
                    "  2. Confirm the board's Nuvoton/ITE Super I/O chip is supported by this LibreHardwareMonitor version.\n" +
                    $"  3. Inspect {reportPath} (or GET /report) for the LPC chip-detection and driver status.");
        }

        using var listener = new HttpListener();
        listener.Prefixes.Add(Prefix);
        try
        {
            listener.Start();
        }
        catch (HttpListenerException ex)
        {
            Console.Error.WriteLine($"Could not bind {Prefix}: {ex.Message}");
            return 1;
        }

        Console.WriteLine($"Listening on {Prefix}");
        Console.WriteLine("Open the app at http://localhost:4173/?adapter=pawnio  (Ctrl+C to stop)");

        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch (Exception) { break; }
            HandleRequest(ctx);
        }

        _monitor.RestoreDefaults();
        return 0;
    }

    private static void HandleRequest(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;

        // CORS: the browser app is served from http://localhost:4173 and calls this
        // service cross-origin; the JSON PUT triggers a preflight.
        res.AddHeader("Access-Control-Allow-Origin", "*");
        res.AddHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
        res.AddHeader("Access-Control-Allow-Headers", "content-type");
        res.AddHeader("Cache-Control", "no-store");

        if (req.HttpMethod == "OPTIONS")
        {
            res.StatusCode = 204;
            res.Close();
            return;
        }

        try
        {
            var segments = req.Url!.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);

            if (req.HttpMethod == "GET" && segments is ["capabilities"])
            {
                WriteJson(res, _monitor.Capabilities());
            }
            else if (req.HttpMethod == "GET" && segments is ["telemetry"])
            {
                WriteJson(res, _monitor.Telemetry());
            }
            else if (req.HttpMethod == "GET" && segments is ["debug"])
            {
                WriteJson(res, _monitor.Discovery());
            }
            else if (req.HttpMethod == "GET" && segments is ["report"])
            {
                WriteText(res, _monitor.Report());
            }
            else if (req.HttpMethod == "PUT" && segments is ["fans", var pwmId, "pwm"])
            {
                var body = ReadBody(req);
                var pwm = JsonDocument.Parse(body).RootElement.GetProperty("pwm").GetDouble();
                var ok = _monitor.SetPwm(Uri.UnescapeDataString(pwmId), pwm);
                if (ok) WriteJson(res, new { ok = true, id = pwmId, pwm });
                else WriteError(res, 404, "Unknown or non-controllable fan");
            }
            else if (req.HttpMethod == "PUT" && segments is ["fans", var cfgId, "config"])
            {
                var patch = JsonSerializer.Deserialize<FanConfigPatch>(ReadBody(req), Json) ?? new FanConfigPatch();
                var ok = _monitor.UpdateConfig(Uri.UnescapeDataString(cfgId), patch);
                if (ok) WriteJson(res, new { ok = true, id = cfgId });
                else WriteError(res, 404, "Unknown fan");
            }
            else
            {
                WriteError(res, 404, "Not found");
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Request error: {ex.Message}");
            try { WriteError(res, 500, ex.Message); } catch { /* response already closed */ }
        }
    }

    private static string ReadBody(HttpListenerRequest req)
    {
        using var reader = new StreamReader(req.InputStream, req.ContentEncoding ?? Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static void WriteJson(HttpListenerResponse res, object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, Json);
        res.StatusCode = 200;
        res.ContentType = "application/json; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        res.OutputStream.Write(bytes);
        res.Close();
    }

    private static void WriteText(HttpListenerResponse res, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        res.StatusCode = 200;
        res.ContentType = "text/plain; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        res.OutputStream.Write(bytes);
        res.Close();
    }

    private static void WriteError(HttpListenerResponse res, int status, string message)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { error = message }, Json);
        res.StatusCode = status;
        res.ContentType = "application/json; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        res.OutputStream.Write(bytes);
        res.Close();
    }
}
