using System.Text.Json;
using System.Text.Json.Serialization;

namespace FanBridge;

// Persisted, user-editable mapping from a hardware fan channel to a friendly label,
// role (cpu cooler vs case fan), and PWM bounds. This is what makes the calibration
// labels stick across restarts.
internal sealed class FanConfigEntry
{
    public string Label { get; set; } = "";
    public string Role { get; set; } = "case"; // "cpu" | "case"
    public int MinPwm { get; set; }
    public int MaxPwm { get; set; } = 100;
}

// Body of PUT /fans/{id}/config — every field optional (partial update).
internal sealed class FanConfigPatch
{
    public string? Label { get; set; }
    public string? Role { get; set; }
    public int? MinPwm { get; set; }
    public int? MaxPwm { get; set; }
}

internal static class FanConfigStore
{
    private static readonly string Path =
        System.IO.Path.Combine(AppContext.BaseDirectory, "fan-config.json");

    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static Dictionary<string, FanConfigEntry> Load()
    {
        try
        {
            if (!File.Exists(Path)) return new Dictionary<string, FanConfigEntry>();
            var json = File.ReadAllText(Path);
            return JsonSerializer.Deserialize<Dictionary<string, FanConfigEntry>>(json, Options)
                   ?? new Dictionary<string, FanConfigEntry>();
        }
        catch
        {
            return new Dictionary<string, FanConfigEntry>();
        }
    }

    public static void Save(Dictionary<string, FanConfigEntry> config)
    {
        try
        {
            File.WriteAllText(Path, JsonSerializer.Serialize(config, Options));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Could not persist fan-config.json: {ex.Message}");
        }
    }
}
