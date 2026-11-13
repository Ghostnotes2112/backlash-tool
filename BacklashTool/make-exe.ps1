# Build BacklashTool-win-x64.exe with Node's BUILT-IN single executable support,
# and nothing downloaded:
#   1. node --experimental-sea-config  -> a blob holding dist/backlash-tool.cjs
#   2. copy this machine's node.exe
#   3. write the blob into the copy as resource RT_RCDATA "NODE_SEA_BLOB"
#      (Windows' own UpdateResource API -- what postject does on Windows)
#   4. flip Node's SEA fuse string from :0 to :1 so it runs the blob
# Run `node build.cjs --bundle-only` first (it writes dist/backlash-tool.cjs).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$cfg  = Join-Path $dist "sea-config.json"
$blob = Join-Path $dist "sea-prep.blob"
$exe  = Join-Path $dist "BacklashTool-win-x64.exe"

@{ main = (Join-Path $dist "backlash-tool.cjs"); output = $blob; disableExperimentalSEAWarning = $true; useCodeCache = $false } |
  ConvertTo-Json | Set-Content -Encoding ascii $cfg
& node --experimental-sea-config $cfg
if ($LASTEXITCODE -ne 0) { throw "sea blob failed" }

$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe $exe -Force

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Res {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool UpdateResource(IntPtr h, IntPtr type, string name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EndUpdateResource(IntPtr h, bool discard);
}
"@
$data = [IO.File]::ReadAllBytes($blob)
$h = [Res]::BeginUpdateResource($exe, $false)
if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
# RT_RCDATA = 10; language 0 (neutral), as postject writes it
if (-not [Res]::UpdateResource($h, [IntPtr]10, "NODE_SEA_BLOB", 0, $data, [uint32]$data.Length)) {
  [void][Res]::EndUpdateResource($h, $true); throw "UpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
if (-not [Res]::EndUpdateResource($h, $false)) { throw "EndUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

# The fuse: exactly one occurrence of the sentinel ending in :0 must exist.
$bytes = [IO.File]::ReadAllBytes($exe)
$fuse  = [Text.Encoding]::ASCII.GetBytes("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0")
$hits = @()
for ($i = 0; $i -le $bytes.Length - $fuse.Length; $i++) {
  if ($bytes[$i] -ne $fuse[0]) { continue }
  $ok = $true
  for ($j = 1; $j -lt $fuse.Length; $j++) { if ($bytes[$i + $j] -ne $fuse[$j]) { $ok = $false; break } }
  if ($ok) { $hits += $i }
}
if ($hits.Count -ne 1) { throw "expected exactly one SEA fuse, found $($hits.Count)" }
$bytes[$hits[0] + $fuse.Length - 1] = [byte][char]'1'
[IO.File]::WriteAllBytes($exe, $bytes)
Remove-Item $blob, $cfg
"built $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB)"
