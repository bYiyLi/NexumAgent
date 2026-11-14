param([Parameter(ValueFromRemainingArguments=$true)][string[]]$InstallArguments)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH,Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue
$NodeArchitecture = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { 'arm64' } else { 'x64' }
$NodeHash = if ($NodeArchitecture -eq 'arm64') { 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171' } else { 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5' }
$BootstrapDirectory = Join-Path ([IO.Path]::GetTempPath()) ('nexum-node-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($BootstrapDirectory) | Out-Null
function Quote-NativeArgument([string]$Value) {
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
try {
    $Archive = Join-Path $BootstrapDirectory 'node.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-$NodeArchitecture.zip" -OutFile $Archive
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant() -ne $NodeHash) { throw 'The bootstrap Node checksum is invalid.' }
    Expand-Archive -LiteralPath $Archive -DestinationPath $BootstrapDirectory
    $NodeExecutable = Join-Path $BootstrapDirectory "node-v24.22.1-win-$NodeArchitecture/node.exe"
    $Installer = Join-Path $PSScriptRoot 'install-agent.mjs'
    if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'Use the complete reviewed installer kit.' }
    $PrivateConfiguration = if ([Console]::IsInputRedirected) { [Console]::In.ReadToEnd() } else { '' }
    $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $NodeExecutable
    $StartInfo.Arguments = (@($Installer) + $InstallArguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $StartInfo.UseShellExecute = $false
    $StartInfo.RedirectStandardInput = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    $StartInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $StartInfo.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $Process = [System.Diagnostics.Process]::Start($StartInfo)
    $Process.StandardInput.Write($PrivateConfiguration)
    $Process.StandardInput.Close()
    $Output = $Process.StandardOutput.ReadToEnd()
    $Diagnostic = $Process.StandardError.ReadToEnd()
    $Process.WaitForExit()
    [Console]::Out.Write($Output)
    [Console]::Error.Write($Diagnostic)
    exit $Process.ExitCode
} finally {
    Remove-Item -LiteralPath $BootstrapDirectory -Force -Recurse -ErrorAction SilentlyContinue
}
