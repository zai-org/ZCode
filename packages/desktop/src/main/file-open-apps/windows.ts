import {
  WINDOWS_ASSOCIATION_ICON_SOURCE,
  WINDOWS_SUITE_ICON_SCRIPT,
  WPS_SUITE_APP_ID,
} from "./windows-icon.js";

/**
 * Shell 提供关联处理器和 IDataObject 启动，不自行拼接注册表 command。
 * 路径和应用身份通过进程环境传入，不能插值进 PowerShell/C# 源码。
 */
export const WINDOWS_APPLICATION_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("973810AE-9599-4B88-9E4D-6EE98C9552DA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IEnumAssocHandlers {
  [PreserveSig] int Next(uint count, [MarshalAs(UnmanagedType.Interface)] out IAssocHandler handler, out uint fetched);
}
[ComImport, Guid("F04061AC-1659-4A3F-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAssocHandler {
  [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
  [PreserveSig] int IsRecommended();
  [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
  [PreserveSig] int Invoke([MarshalAs(UnmanagedType.Interface)] IDataObject data);
}
[ComImport, Guid("71E806FB-8DEE-46FC-BF8C-7748A8A1AE13"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IObjectWithProgID {
  [PreserveSig] int SetProgID([MarshalAs(UnmanagedType.LPWStr)] string id);
  [PreserveSig] int GetProgID([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[ComImport, Guid("36DB0196-9665-46D1-9BA7-D3709EECF9ED"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IObjectWithAppUserModelID {
  [PreserveSig] int SetAppID([MarshalAs(UnmanagedType.LPWStr)] string id);
  [PreserveSig] int GetAppID([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[ComImport, Guid("4E530B0A-E611-4C77-A3AC-9031D022281B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationAssociationRegistration {
  [PreserveSig] int QueryCurrentDefault([MarshalAs(UnmanagedType.LPWStr)] string query, int type, int level, [MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
  [PreserveSig] int BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IDataObject data);
}
public class FileAppRecord {
  public string key;
  public string identity;
  public string name;
  public string iconPath;
  public int iconIndex;
  public int iconLocationHresult;
  public string iconDataUrl;
  public string suiteIconPath;
  public string suiteIconDataUrl;
  public string progId;
  public string appId;
  public bool isDefault;
}
public class DefaultAssociation {
  public string progId;
  public string appId;
  public string executable;
}
public class FileApplicationQuery {
  public List<FileAppRecord> applications = new List<FileAppRecord>();
  public DefaultAssociation defaultAssociation;
}
${WINDOWS_ASSOCIATION_ICON_SOURCE}
public static class NativeFileApps {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHAssocEnumHandlers(string extension, uint filter, out IEnumAssocHandlers handlers);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern uint AssocQueryString(uint flags, uint kind, string assoc, string extra, StringBuilder output, ref uint length);
  static string ReadAssociation(string association, uint kind) {
    if (String.IsNullOrWhiteSpace(association)) return null;
    uint length = 32768;
    var value = new StringBuilder((int)length);
    return AssocQueryString(0, kind, association, null, value, ref length) == 0 ? value.ToString() : null;
  }
  static DefaultAssociation ReadEffectiveDefault(string extension) {
    object registration = null;
    try {
      registration = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("591209C7-767B-42B2-9FBA-44EE4615F2C7")));
      string progId;
      // AL_EFFECTIVE 返回 Shell 实际会打开的关联；UserChoice 注册值可能未实际生效。
      if (((IApplicationAssociationRegistration)registration).QueryCurrentDefault(extension, 0, 1, out progId) != 0 || String.IsNullOrWhiteSpace(progId)) return null;
      return new DefaultAssociation { progId = progId, appId = ReadAssociation(progId, 21), executable = ReadAssociation(progId, 2) };
    } catch { return null; }
    finally { if (registration != null) Marshal.ReleaseComObject(registration); }
  }
  static string ReadProgId(IAssocHandler handler) {
    try { string value; return ((IObjectWithProgID)handler).GetProgID(out value) == 0 ? value : null; }
    catch { return null; }
  }
  static string ReadAppId(IAssocHandler handler) {
    try { string value; return ((IObjectWithAppUserModelID)handler).GetAppID(out value) == 0 ? value : null; }
    catch { return null; }
  }
  public static FileApplicationQuery Query(string path, bool includeIcons = true) {
    var result = new FileApplicationQuery();
    var extension = Path.GetExtension(path);
    if (String.IsNullOrEmpty(extension)) return result;
    result.defaultAssociation = ReadEffectiveDefault(extension);
    IEnumAssocHandlers handlers;
    if (SHAssocEnumHandlers(extension, 1, out handlers) < 0 || handlers == null) return result;
    try {
      IAssocHandler handler; uint fetched;
      while (handlers.Next(1, out handler, out fetched) == 0 && fetched == 1) {
        try {
          string key, name, icon; int index;
          if (handler.GetName(out key) < 0 || handler.GetUIName(out name) < 0) continue;
          int iconResult = handler.GetIconLocation(out icon, out index);
          if (String.IsNullOrEmpty(key) || String.IsNullOrEmpty(name)) continue;
          string progId = ReadProgId(handler), appId = ReadAppId(handler);
          // wps.exe 是共享启动载体，Writer 图不能冒充 WPS 套件总图。
          bool suiteHandler = String.Equals(appId, ${JSON.stringify(WPS_SUITE_APP_ID)}, StringComparison.OrdinalIgnoreCase);
          result.applications.Add(new FileAppRecord {
            key = key, name = name,
            identity = File.Exists(key)
              ? "windows-executable:" + Path.GetFullPath(key).ToLowerInvariant()
              : "windows-handler:" + key.ToLowerInvariant(),
            // 关联资源不等于 exe 文件图标；保留原始路径/索引，间接资源由系统解析。
            iconPath = icon, iconIndex = index, iconLocationHresult = iconResult,
            iconDataUrl = includeIcons && !suiteHandler && iconResult == 0 ? WindowsAssociationIcon.Read(icon, index) : null,
            progId = progId, appId = appId, isDefault = false
          });
        } finally { Marshal.ReleaseComObject(handler); }
      }
    } finally { Marshal.ReleaseComObject(handlers); }
    return result;
  }
  public static void Open(string path, string selected) {
    // Shell 解析名只接受规范 Windows 路径；正斜杠会让 SHCreateItemFromParsingName 返回 E_INVALIDARG。
    path = Path.GetFullPath(path);
    IEnumAssocHandlers handlers;
    Marshal.ThrowExceptionForHR(SHAssocEnumHandlers(Path.GetExtension(path), 1, out handlers));
    try {
      IAssocHandler handler; uint fetched;
      while (handlers.Next(1, out handler, out fetched) == 0 && fetched == 1) {
        try {
          string key; handler.GetName(out key);
          if (!String.Equals(key, selected, StringComparison.Ordinal)) continue;
          var itemId = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
          IShellItem item;
          Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref itemId, out item));
          try {
            var handlerId = new Guid("B8C0BD9F-ED24-455C-83E6-D5390C4FE8C4");
            var dataId = new Guid("0000010E-0000-0000-C000-000000000046");
            IDataObject data;
            Marshal.ThrowExceptionForHR(item.BindToHandler(IntPtr.Zero, ref handlerId, ref dataId, out data));
            try { Marshal.ThrowExceptionForHR(handler.Invoke(data)); }
            finally { Marshal.ReleaseComObject(data); }
          } finally { Marshal.ReleaseComObject(item); }
          return;
        } finally { Marshal.ReleaseComObject(handler); }
      }
      throw new InvalidOperationException("application_not_available");
    } finally { if (handlers != null) Marshal.ReleaseComObject(handlers); }
  }
}
'@
if ($env:ZCODE_FILE_APP_ACTION -eq 'open') {
  [NativeFileApps]::Open($env:ZCODE_FILE_APP_PATH, $env:ZCODE_FILE_APP_HANDLER)
} else {
  $zcodeQuery = [NativeFileApps]::Query($env:ZCODE_FILE_APP_PATH, ($env:ZCODE_FILE_APP_INCLUDE_ICONS -ne '0'))
  ${WINDOWS_SUITE_ICON_SCRIPT}
  ConvertTo-Json -InputObject $zcodeQuery -Depth 6 -Compress
}
`
  // 增加原生资源解析后，UTF-16 Base64 接近 Windows 命令行上限；不传输排版缩进和独立注释。
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("//"))
  .join("\n");
