# Install the verified Windows release executable for the current user.
# Set $env:AGENT_CONSOLE_VERSION='vX.Y.Z' for an earlier release.
$ErrorActionPreference = 'Stop'
$repo = 'SamSnead85/agent-console'
if ([Environment]::Is64BitOperatingSystem -ne $true -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) {
  throw 'The Windows executable currently requires x64 Windows.'
}
$version = $env:AGENT_CONSOLE_VERSION
if (-not $version) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'agent-console-installer' }
  $version = $release.tag_name
}
if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Could not determine a release tag. Set AGENT_CONSOLE_VERSION=vX.Y.Z.' }

$asset = 'agent-console-win32-x64.exe'
$base = "https://github.com/$repo/releases/download/$version"
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("agent-console-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  $sums = Join-Path $scratch 'SHA256SUMS'
  $binary = Join-Path $scratch $asset
  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $binary
  $matching = @(Get-Content $sums | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($asset))$" })
  if ($matching.Count -ne 1) { throw 'Release checksum is missing or ambiguous.' }
  $expected = ($matching[0] -split '\s+')[0]
  $actual = (Get-FileHash -Path $binary -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw 'SHA-256 mismatch. Nothing was installed.' }
  $destination = if ($env:AGENT_CONSOLE_INSTALL_DIR) { $env:AGENT_CONSOLE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\AgentConsole' }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $target = Join-Path $destination 'agent-console.exe'
  Copy-Item -Path $binary -Destination $target -Force
  Write-Output "Installed $version to $target"
  Write-Output "Run: & '$target' --open"
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
