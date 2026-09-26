# Install the Agent Console executable for Windows, for the current user only.
# It installs nothing unless the download matches the release's SHA256SUMS,
# then puts its folder on your PATH so `agent-console` works in a new window.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# Runs in Windows PowerShell 5.1 and PowerShell 7. It uses no GitHub API, so
# there is no rate limit to hit: the latest release is wherever
# github.com/<repository>/releases/latest redirects.
#
#   $env:AGENT_CONSOLE_VERSION = 'vX.Y.Z'      that release instead of the latest
#   $env:AGENT_CONSOLE_INSTALL_DIR = 'D:\...'  that folder instead of AppData\Local\Programs\AgentConsole
#   $env:AGENT_CONSOLE_NO_MODIFY_PATH = '1'    leave PATH as it is
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 redraws its progress bar for every block it receives,
# which turns a 100 MB download into minutes; and on older .NET it offers only
# TLS versions GitHub refuses. Ask for TLS 1.2 (3072) alongside what it has.
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
# A proxy that needs you signed in gets your Windows sign-in, as a browser would.
try { if ([Net.WebRequest]::DefaultWebProxy) { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } } catch { }

$repo = 'SamSnead85/agent-console'
$proxyHelp = 'Behind a proxy or TLS inspection? See https://github.com/SamSnead85/agent-console/blob/main/docs/standalone-install.md#behind-a-proxy'

function Get-File([string] $Uri, [string] $Path) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Path
  } catch {
    throw "Could not download $Uri ($($_.Exception.Message)). Nothing was installed. $proxyHelp"
  }
}

$version = $env:AGENT_CONSOLE_VERSION
if (-not $version) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri "https://github.com/$repo/releases/latest"
  } catch {
    throw "Could not reach github.com to find the latest release ($($_.Exception.Message)). $proxyHelp"
  }
  # Where the redirect ended: ResponseUri in Windows PowerShell 5.1, RequestMessage in PowerShell 7.
  $final = $response.BaseResponse.ResponseUri
  if (-not $final) { $final = $response.BaseResponse.RequestMessage.RequestUri }
  $version = ([string] $final).TrimEnd('/').Split('/')[-1]
}
if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Could not determine a release tag. Set $env:AGENT_CONSOLE_VERSION to vX.Y.Z.' }
$package = "https://github.com/$repo/releases/download/$version/lockedinlabs-agent-console-$($version.Substring(1)).tgz"

# The executable is x64. Windows 11 on Arm runs x64 programs; Windows 10 on Arm does not.
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -eq 'ARM64') {
  if ([Environment]::OSVersion.Version.Build -lt 22000) {
    throw "The Windows executable is x64, which Windows 10 on Arm cannot run. With Node.js 22 or newer, run instead: npx.cmd --yes $package --open"
  }
  Write-Output 'Windows on Arm: installing the x64 executable, which Windows 11 runs under emulation.'
} elseif ($arch -ne 'AMD64') {
  throw "There is no Agent Console executable for $arch Windows; it needs 64-bit Windows. With Node.js 22 or newer, run instead: npx.cmd --yes $package --open"
}

$asset = 'agent-console-win32-x64.exe'
$base = "https://github.com/$repo/releases/download/$version"
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('agent-console-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  $sums = Join-Path $scratch 'SHA256SUMS'
  $binary = Join-Path $scratch $asset
  Get-File "$base/SHA256SUMS" $sums
  Write-Output "Downloading $asset ($version)..."
  Get-File "$base/$asset" $binary
  $matching = @(Get-Content $sums | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($asset))$" })
  if ($matching.Count -ne 1) { throw 'Release checksum is missing or ambiguous. Nothing was installed.' }
  $expected = ($matching[0] -split '\s+')[0]
  $actual = (Get-FileHash -Path $binary -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw 'SHA-256 mismatch. Nothing was installed.' }
  $destination = if ($env:AGENT_CONSOLE_INSTALL_DIR) { $env:AGENT_CONSOLE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\AgentConsole' }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $destination = (Resolve-Path -LiteralPath $destination).ProviderPath
  $target = Join-Path $destination 'agent-console.exe'
  try {
    Copy-Item -Path $binary -Destination $target -Force
  } catch {
    throw "Could not replace $target ($($_.Exception.Message)). If Agent Console is running, stop it (Ctrl+C in its window; agent-console stop for a background reporter), then run this installer again."
  }
  Write-Output "Installed $version to $target (SHA-256 matches the release's SHA256SUMS)"
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

# PATH: the user's own PATH, in the registry, keeping any %VARIABLE% in it as
# it is; then tell Windows, so windows opened from now on see the change.
$same = { param($entry) $entry -and $entry.TrimEnd('\') -eq $destination.TrimEnd('\') }
$onPath = @($env:Path -split ';' | Where-Object { & $same $_ }).Count -gt 0
$added = $false
$announced = $false
if (-not $onPath -and $env:AGENT_CONSOLE_NO_MODIFY_PATH -ne '1') {
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $current = [string] $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = @($current -split ';' | Where-Object { $_ })
      if (-not ($entries | Where-Object { & $same $_ })) {
        $key.SetValue('Path', (($entries + $destination) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      }
      $added = $true
    } finally { $key.Close() }
  } catch {
    Write-Warning "Could not add $destination to your PATH: $($_.Exception.Message)"
  }
  if ($added) {
    try {
      if (-not ('AgentConsoleInstall.Native' -as [Type])) {
        Add-Type -Namespace AgentConsoleInstall -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
      }
      $ignored = [UIntPtr]::Zero
      [AgentConsoleInstall.Native]::SendMessageTimeout([IntPtr] 0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref] $ignored) | Out-Null
      $announced = $true
    } catch { }
  }
}

Write-Output ''
if ($onPath) {
  Write-Output 'Start it:  agent-console --open'
} elseif ($added) {
  if ($announced) {
    Write-Output "Added $destination to your PATH. In a new PowerShell window:  agent-console --open"
  } else {
    Write-Output "Added $destination to your PATH; new windows see it after you sign out and in again. Then:  agent-console --open"
  }
  Write-Output "In this window:  & '$target' --open"
} else {
  Write-Output "Start it:  & '$target' --open"
  Write-Output 'To run it as just agent-console: Start, type "environment variables", open "Edit environment variables for your account",'
  Write-Output "choose Path, Edit, New, and enter:  $destination   Then open a new PowerShell window."
}
