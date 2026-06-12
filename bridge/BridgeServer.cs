using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FanBridge;

// In-process HTTP server: serves the web UI (same origin, so no CORS is needed by the
// app itself) and the hardware API the UI calls:
//   GET  /capabilities
//   GET  /telemetry
//   GET  /debug, /report
//   PUT  /fans/{id}/pwm     body { "pwm": 55 }
//   PUT  /fans/{id}/config  body { "label": "...", "role": "...", "fanType": "...", ... }
internal sealed class BridgeServer
{
    public const string Prefix = "http://127.0.0.1:9876/";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".ico"] = "image/x-icon"
    };

    private readonly HardwareMonitor _monitor;
    private readonly string _webRoot;
    private readonly HttpListener _listener = new();

    public BridgeServer(HardwareMonitor monitor)
    {
        _monitor = monitor;
        _webRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "public"));
    }

    public void Start()
    {
        _listener.Prefixes.Add(Prefix);
        _listener.Start();
        var thread = new Thread(Loop) { IsBackground = true, Name = "BridgeServer" };
        thread.Start();
    }

    public void Stop()
    {
        try { _listener.Stop(); } catch { /* already stopped */ }
    }

    private void Loop()
    {
        while (_listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = _listener.GetContext(); }
            catch (Exception) { break; }
            try { HandleRequest(ctx); }
            catch (Exception ex) { Log.Write($"Request error: {ex.Message}"); }
        }
    }

    private void HandleRequest(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;

        // CORS kept for the browser-dev workflow (UI served from another origin).
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
            else if (req.HttpMethod == "GET")
            {
                ServeStatic(res, req.Url!.AbsolutePath);
            }
            else
            {
                WriteError(res, 404, "Not found");
            }
        }
        catch (Exception ex)
        {
            Log.Write($"Request error: {ex.Message}");
            try { WriteError(res, 500, ex.Message); } catch { /* response already closed */ }
        }
    }

    private void ServeStatic(HttpListenerResponse res, string path)
    {
        var relative = path == "/" ? "index.html" : path.TrimStart('/');
        var full = Path.GetFullPath(Path.Combine(_webRoot, relative));
        if (!full.StartsWith(_webRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
        {
            WriteError(res, 404, "Not found");
            return;
        }

        var bytes = File.ReadAllBytes(full);
        res.StatusCode = 200;
        res.ContentType = ContentTypes.GetValueOrDefault(Path.GetExtension(full), "application/octet-stream");
        res.ContentLength64 = bytes.Length;
        res.OutputStream.Write(bytes);
        res.Close();
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

// The app has no console window, so diagnostics go to a log file next to the exe.
internal static class Log
{
    private static readonly object Gate = new();
    private static readonly string Path =
        System.IO.Path.Combine(AppContext.BaseDirectory, "fanbridge-log.txt");

    static Log()
    {
        try { File.WriteAllText(Path, $"Automatic Fan Tuner started {DateTime.Now:O}\r\n"); }
        catch { /* read-only install dir; logging becomes best-effort */ }
    }

    public static void Write(string message)
    {
        lock (Gate)
        {
            try { File.AppendAllText(Path, $"{DateTime.Now:HH:mm:ss}  {message}\r\n"); }
            catch { /* best effort */ }
        }
    }
}
