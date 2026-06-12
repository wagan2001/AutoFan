using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FanBridge;

// Automatic Fan Tuner desktop app. One elevated process hosts everything:
//  - LibreHardwareMonitor (PawnIO-backed) for sensors and fan PWM control,
//  - an in-process HTTP server on 127.0.0.1:9876 serving the web UI + hardware API,
//  - a WinForms window with WebView2 showing the UI (same origin as the API).
internal static class Program
{
    private static HardwareMonitor? _monitor;

    [STAThread]
    private static int Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        try
        {
            _monitor = new HardwareMonitor();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Failed to initialize hardware access: {ex.Message}\n\n" +
                "Ensure the app is running as administrator and the PawnIO driver is installed.",
                "Automatic Fan Tuner", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        // Safety: always hand fans back to BIOS control when we exit, however we exit.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => _monitor.RestoreDefaults();
        AppDomain.CurrentDomain.UnhandledException += (_, _) => _monitor.RestoreDefaults();
        Application.ApplicationExit += (_, _) => _monitor.RestoreDefaults();

        var fans = _monitor.Snapshot().Fans;
        Log.Write($"Detected {fans.Count} fan channel(s): " +
                  string.Join(", ", fans.Select(f => $"{f.Config.Label}[{f.Source}{(f.Controllable ? ",ctl" : "")}]")));

        try
        {
            File.WriteAllText(
                Path.Combine(AppContext.BaseDirectory, "lhm-report.txt"),
                _monitor.Report());
        }
        catch (Exception ex)
        {
            Log.Write($"Could not write LHM report: {ex.Message}");
        }

        var server = new BridgeServer(_monitor);
        try
        {
            server.Start();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Could not start the local service on {BridgeServer.Prefix}: {ex.Message}\n\n" +
                "Is another instance (or the old Node server) already running?",
                "Automatic Fan Tuner", MessageBoxButtons.OK, MessageBoxIcon.Error);
            _monitor.RestoreDefaults();
            return 1;
        }

        Log.Write($"Serving UI and API on {BridgeServer.Prefix}");
        Application.Run(new MainForm(BridgeServer.Prefix));

        server.Stop();
        _monitor.RestoreDefaults();
        return 0;
    }
}

internal sealed class MainForm : Form
{
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly string _url;

    public MainForm(string url)
    {
        _url = url;
        Text = "Automatic Fan Tuner";
        ClientSize = new Size(1320, 920);
        MinimumSize = new Size(900, 640);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(17, 20, 24); // matches the UI background while loading
        Controls.Add(_webView);
        Load += async (_, _) => await InitializeWebViewAsync();
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            // The app runs elevated and may be installed somewhere read-only, so the
            // WebView2 profile goes to LocalAppData. Background timer throttling is
            // disabled so the optimizer's 1 Hz loop keeps full rate while minimized
            // (the bridge-side PWM hold is the hard guarantee; this keeps telemetry
            // and scenario capture continuous too).
            var dataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "AutomaticFanTuner", "WebView2");
            var options = new CoreWebView2EnvironmentOptions(
                additionalBrowserArguments: "--disable-background-timer-throttling");
            var environment = await CoreWebView2Environment.CreateAsync(null, dataFolder, options);
            await _webView.EnsureCoreWebView2Async(environment);

            var settings = _webView.CoreWebView2.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = true;

            _webView.CoreWebView2.Navigate(_url);
        }
        catch (Exception ex)
        {
            Log.Write($"WebView2 initialization failed: {ex.Message}");
            MessageBox.Show(
                $"Could not start the embedded browser (WebView2): {ex.Message}\n\n" +
                "Install the WebView2 Runtime from Microsoft if it is missing, or open " +
                _url + " in a browser — the service keeps running while this window is open.",
                "Automatic Fan Tuner", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
}
