using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class AgendaWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    private delegate bool WindowVisitor(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    private sealed class Source
    {
        public string handle { get; set; }
        public int pid { get; set; }
        public string started { get; set; }
        public string title { get; set; }
        public string application { get; set; }
    }

    private static Source Identify(IntPtr window)
    {
        if (!IsWindowVisible(window)) return null;
        int pid;
        if (GetWindowThreadProcessId(window, out pid) == 0) return null;
        var title = new StringBuilder(512);
        if (GetWindowText(window, title, title.Capacity) == 0) return null;
        try
        {
            using (var process = Process.GetProcessById(pid))
            {
                if (string.Equals(process.ProcessName, "Obsidian", StringComparison.OrdinalIgnoreCase)) return null;
                return new Source {
                    handle = window.ToInt64().ToString(), pid = pid, title = title.ToString(),
                    started = process.StartTime.ToUniversalTime().Ticks.ToString(), application = process.ProcessName
                };
            }
        }
        catch (SystemException) { return null; }
    }

    private static Source[] List()
    {
        var items = new List<Source>();
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            var source = Identify(window);
            if (source != null) items.Add(source);
            return true;
        }, IntPtr.Zero);
        return items.ToArray();
    }

    private static bool Matches(IntPtr window, Source expected)
    {
        var actual = Identify(window);
        return actual != null && actual.pid == expected.pid && actual.started == expected.started &&
            actual.title == expected.title;
    }

    private static object Capture(IntPtr window, Source expected, Rectangle requested, Rectangle viewport)
    {
        if (!Matches(window, expected)) throw new InvalidOperationException();
        Rect bounds;
        if (IsIconic(window) || !GetWindowRect(window, out bounds)) return null;
        var windowRect = Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
        if (!windowRect.IntersectsWith(viewport)) return null;
        var area = Rectangle.Intersect(requested, windowRect);
        if (area.Width <= 0 || area.Height <= 0 || windowRect.Width > 8192 || windowRect.Height > 8192 ||
            (long)windowRect.Width * windowRect.Height > 24000000) return null;
        using (var bitmap = new Bitmap(windowRect.Width, windowRect.Height, PixelFormat.Format32bppRgb))
        {
            using (var graphics = Graphics.FromImage(bitmap))
            {
                var dc = graphics.GetHdc();
                try { if (!PrintWindow(window, dc, 2)) return null; }
                finally { graphics.ReleaseHdc(dc); }
            }
            if (!Matches(window, expected)) throw new InvalidOperationException();
            if (IsIconic(window) || !GetWindowRect(window, out bounds) ||
                Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom) != windowRect) return null;
            using (var image = bitmap.Clone(new Rectangle(area.X - windowRect.X, area.Y - windowRect.Y, area.Width, area.Height),
                PixelFormat.Format32bppRgb))
            using (var bytes = new MemoryStream())
            {
                image.Save(bytes, ImageFormat.Jpeg);
                return new { x = area.X, y = area.Y, width = area.Width, height = area.Height,
                    image = Convert.ToBase64String(bytes.ToArray()) };
            }
        }
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer { MaxJsonLength = 6000000 };
        try
        {
            if (args.Length == 1 && args[0] == "list")
            {
                Console.WriteLine(json.Serialize(List()));
                return 0;
            }
            if (args.Length != 2 || args[0] != "capture") return 1;
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            var source = json.Deserialize<Source>(Encoding.UTF8.GetString(Convert.FromBase64String(args[1])));
            var window = new IntPtr(long.Parse(source.handle));
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                var crop = Array.ConvertAll(line.Split(','), int.Parse);
                if (crop.Length != 8 || crop[2] < 1 || crop[3] < 1 || crop[2] > 8192 || crop[3] > 8192) return 1;
                Console.WriteLine(json.Serialize(Capture(window, source, new Rectangle(crop[0], crop[1], crop[2], crop[3]),
                    new Rectangle(crop[4], crop[5], crop[6], crop[7]))));
            }
            return 0;
        }
        catch (Exception) { return 1; }
    }
}
