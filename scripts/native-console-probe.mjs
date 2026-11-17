// Pure Windows console probe source. Keep PowerShell's here-string syntax
// testable on every platform, including CI runners that cannot run PowerShell.
export function windowsConsoleProbe(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff)
    throw new Error("Use a real Windows process ID for the console probe.");
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -Namespace NexumNativeProbe -Name Console -MemberDefinition @'",
    '[System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)] public static extern bool FreeConsole();',
    '[System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint pid);',
    "'@",
    "[NexumNativeProbe.Console]::FreeConsole()|Out-Null",
    "$attached=[NexumNativeProbe.Console]::AttachConsole([uint32]" + pid + ")",
    "$last=[System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "if($attached){[NexumNativeProbe.Console]::FreeConsole()|Out-Null;exit 11}",
    "if($last -ne 6){exit 12}",
    "exit 0",
  ].join("\n");
}
