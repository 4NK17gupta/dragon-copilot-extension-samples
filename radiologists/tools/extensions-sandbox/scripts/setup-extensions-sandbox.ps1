#Requires -Version 5.1

<#
.SYNOPSIS
    Downloads the Dragon Copilot extension samples and runs the Extensions Sandbox.

.DESCRIPTION
    1. Checks for Git, Node.js (^20.19.0 or >=22.12.0) and npm 9+. With
       -InstallPrerequisites, missing ones are installed with winget (Windows only).
    2. Gets the source:
       - Run from the scripts folder of a copy of the repository you already have
         (a clone or an extracted ZIP), it uses that copy as it is: nothing is
         downloaded, and your branch and changes are left alone. Git isn't needed.
       - Run from anywhere else, or with -InstallDir, -Branch or -RepoUrl, it clones
         the branch into -InstallDir, or updates that clone (switching to the branch
         if needed). Updates are fast-forward only; a clone with local changes is
         left as it is.
    3. Installs the sandbox's dependencies with 'npm ci' (skipped when nothing changed).
    4. Starts the sandbox with 'npm run dev' and opens http://localhost:3000.
       Press Ctrl+C to stop it.

    Run the script again at any time to update to the latest commit and restart.
    See README.md next to this script for step-by-step instructions.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup-extensions-sandbox.ps1

.EXAMPLE
    .\setup-extensions-sandbox.ps1 -InstallDir D:\src\dragon-samples -InstallPrerequisites

.EXAMPLE
    .\setup-extensions-sandbox.ps1 -SetupOnly

.EXAMPLE
    .\setup-extensions-sandbox.ps1 -Branch AIDraft_QualityCheck_UXChanges -InstallDir $HOME\dragon-samples-aidraft
#>
[CmdletBinding()]
param(
    # Folder the repository is cloned into, and reused on later runs. When the script is run
    # from a copy of the repository and this isn't given, that copy is used instead.
    [string]$InstallDir = (Join-Path $HOME 'dragon-copilot-extension-samples'),

    [string]$RepoUrl = 'https://github.com/4NK17gupta/dragon-copilot-extension-samples.git',

    [string]$Branch = 'Partner',

    # Install missing or outdated Git / Node.js with winget (Windows only).
    [switch]$InstallPrerequisites,

    # Use the existing clone as it is; don't fetch the latest commits.
    [switch]$SkipUpdate,

    # Run 'npm ci' even if the dependencies look up to date.
    [switch]$ForceInstall,

    # Download and install only; don't start the sandbox.
    [switch]$SetupOnly,

    # Don't open the browser once the sandbox is ready.
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SandboxUrl = 'http://localhost:3000'
$SandboxPorts = @(3000, 4000)
$OnWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
# npm.cmd rather than npm, so a restrictive execution policy can't block npm.ps1.
$Npm = if ($OnWindows) { 'npm.cmd' } else { 'npm' }

# Run from the scripts folder of a copy of the repository, without -InstallDir, -Branch or
# -RepoUrl, the script uses that copy as it is instead of cloning.
$UseScriptRepo = $false
$sourceParameterGiven = $PSBoundParameters.ContainsKey('InstallDir') -or $PSBoundParameters.ContainsKey('Branch') -or $PSBoundParameters.ContainsKey('RepoUrl')
if ($PSScriptRoot -and -not $sourceParameterGiven) {
    $scriptRepoRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..', '..', '..', '..'))
    $expectedSandboxDir = [System.IO.Path]::Combine($scriptRepoRoot, 'radiologists', 'tools', 'extensions-sandbox')
    $scriptDir = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
    if ($scriptDir -eq (Join-Path $expectedSandboxDir 'scripts') -and (Test-Path -LiteralPath (Join-Path $expectedSandboxDir 'package.json'))) {
        $UseScriptRepo = $true
        $InstallDir = $scriptRepoRoot
    }
}

$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
$SandboxDir = [System.IO.Path]::Combine($InstallDir, 'radiologists', 'tools', 'extensions-sandbox')

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Info([string]$Message) { Write-Host "    $Message" }
function Write-Warn([string]$Message) { Write-Host "    WARNING: $Message" -ForegroundColor Yellow }

# Runs a native command and throws if it exits with a non-zero code.
function Invoke-Native([string]$Command, [string[]]$Arguments, [string]$FailureMessage) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)."
    }
}

function Get-ToolVersion([string]$Command) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return $null }
    $output = & $Command --version | Select-Object -First 1
    if ("$output" -match '(\d+)\.(\d+)\.(\d+)') {
        return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
    }
    return $null
}

function Test-NodeVersionSupported([version]$Version) {
    # Same range as the sandbox's "engines" field: ^20.19.0 || >=22.12.0
    return (($Version.Major -eq 20 -and $Version.Minor -ge 19) -or $Version -ge [version]'22.12.0')
}

# Adds PATH entries created by an installer to this session, keeping the existing ones.
function Update-SessionPath {
    $entries = New-Object System.Collections.Generic.List[string]
    $sources = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
    foreach ($source in $sources) {
        if (-not $source) { continue }
        foreach ($entry in $source.Split(';')) {
            if ($entry -and -not $entries.Contains($entry)) { $entries.Add($entry) }
        }
    }
    $env:Path = $entries -join ';'
}

function Install-WithWinget([string]$Id, [string]$Name) {
    if (-not $OnWindows) {
        throw "-InstallPrerequisites only works on Windows. Install $Name yourself and run the script again."
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget isn't available, so $Name can't be installed automatically. Install it yourself and run the script again."
    }
    Write-Info "Installing $Name with winget ($Id)..."
    & winget install --id $Id --exact --source winget --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "winget exited with code $LASTEXITCODE while installing $Name."
    }
    Update-SessionPath
}

function Assert-Prerequisites {
    Write-Step 'Checking prerequisites'
    $problems = New-Object System.Collections.Generic.List[string]
    $wingetHint = if ($OnWindows) { ' Or run this script with -InstallPrerequisites.' } else { '' }

    if (-not $UseScriptRepo) {
        if ($InstallPrerequisites -and -not (Get-ToolVersion 'git')) {
            Install-WithWinget -Id 'Git.Git' -Name 'Git'
        }
        $gitVersion = Get-ToolVersion 'git'
        if ($gitVersion) {
            Write-Info "Git $gitVersion"
        }
        else {
            $problems.Add("Git isn't installed. Get it from https://git-scm.com/downloads.$wingetHint")
        }
    }

    $nodeVersion = Get-ToolVersion 'node'
    if ($InstallPrerequisites -and -not ($nodeVersion -and (Test-NodeVersionSupported $nodeVersion))) {
        Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS'
        $nodeVersion = Get-ToolVersion 'node'
    }
    if (-not $nodeVersion) {
        $problems.Add("Node.js isn't installed. Install the LTS version (22.12 or later) from https://nodejs.org.$wingetHint")
    }
    elseif (-not (Test-NodeVersionSupported $nodeVersion)) {
        $problems.Add("Node.js $nodeVersion is too old; the sandbox needs ^20.19.0 or >=22.12.0. Install the LTS version from https://nodejs.org.$wingetHint")
    }
    else {
        Write-Info "Node.js $nodeVersion"
    }

    if ($nodeVersion) {
        $npmVersion = Get-ToolVersion $Npm
        if (-not $npmVersion) {
            $problems.Add("npm wasn't found. It's installed with Node.js; reinstall Node.js from https://nodejs.org.")
        }
        elseif ($npmVersion.Major -lt 9) {
            $problems.Add("npm $npmVersion is too old; the sandbox needs npm 9 or later. Run: npm install -g npm@latest")
        }
        else {
            Write-Info "npm $npmVersion"
        }
    }

    if ($problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-Host "    - $problem" -ForegroundColor Red }
        throw 'Install the missing prerequisites (open a new terminal afterwards), then run this script again.'
    }
}

# Describes what is listening on a local port, or returns $null if nothing is.
function Get-PortListener([int]$Port) {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $connection) { return $null }
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if ($process) { return "$($process.ProcessName), PID $($process.Id)" }
        return "PID $($connection.OwningProcess)"
    }

    foreach ($address in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
        $client = $null
        try {
            $client = New-Object System.Net.Sockets.TcpClient($address.AddressFamily)
            if ($client.ConnectAsync($address, $Port).Wait(1000) -and $client.Connected) {
                return 'another process'
            }
        }
        catch {
            # Connection refused, or IPv6 unavailable: nothing is listening there.
        }
        finally {
            if ($client) { $client.Dispose() }
        }
    }
    return $null
}

function Assert-PortsFree {
    $busy = @()
    foreach ($port in $SandboxPorts) {
        $listener = Get-PortListener $port
        if ($listener) { $busy += "$port ($listener)" }
    }
    if ($busy.Count -gt 0) {
        throw ("The sandbox needs ports 3000 and 4000, but these are in use: {0}. If the sandbox is already running in another window, use that or stop it with Ctrl+C, then run this script again." -f ($busy -join ', '))
    }
}

function ConvertTo-ComparableRepoUrl([string]$Url) {
    $normalized = $Url.Trim().TrimEnd('/')
    if ($normalized.EndsWith('.git')) { $normalized = $normalized.Substring(0, $normalized.Length - 4) }
    $normalized = $normalized -replace '^git@github\.com:', 'https://github.com/'
    return $normalized.ToLowerInvariant()
}

function Update-Clone {
    $origin = & git -C $InstallDir config --get remote.origin.url
    if ($LASTEXITCODE -ne 0 -or (ConvertTo-ComparableRepoUrl $origin) -ne (ConvertTo-ComparableRepoUrl $RepoUrl)) {
        throw "$InstallDir is a clone of '$origin', not $RepoUrl. Use -InstallDir to choose another folder."
    }

    $currentBranch = & git -C $InstallDir rev-parse --abbrev-ref HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "Couldn't read the current branch in $InstallDir (exit code $LASTEXITCODE). Check the git message above."
    }

    if ($SkipUpdate) {
        Write-Info 'Using the existing clone as it is (-SkipUpdate).'
        if ($currentBranch -cne $Branch) { Write-Warn "The clone is on '$currentBranch', not '$Branch'." }
        return
    }

    $changes = & git -C $InstallDir status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw "git status failed in $InstallDir (exit code $LASTEXITCODE). Check the git message above."
    }
    if ($changes) {
        if ($currentBranch -cne $Branch) {
            throw "$InstallDir has local changes on '$currentBranch', so it can't switch to '$Branch'. Commit, stash or discard them, or use -InstallDir to set up '$Branch' in another folder."
        }
        Write-Warn "$InstallDir has local changes, so it wasn't updated. Commit, stash or discard them to get the latest version."
        return
    }

    # Clones made by this script track a single branch; register this one so it can be tracked too.
    $refspec = "+refs/heads/${Branch}:refs/remotes/origin/$Branch"
    $refspecs = @(& git -C $InstallDir config --get-all remote.origin.fetch)
    if ($refspecs -cnotcontains $refspec -and $refspecs -cnotcontains '+refs/heads/*:refs/remotes/origin/*') {
        Invoke-Native git @('-C', $InstallDir, 'remote', 'set-branches', '--add', 'origin', $Branch) "Couldn't add $Branch to the clone"
    }

    Write-Info "Fetching the latest $Branch from origin"
    Invoke-Native git @('-C', $InstallDir, 'fetch', 'origin', $refspec) 'git fetch failed'

    if ($currentBranch -cne $Branch) {
        Write-Info "Switching from $currentBranch to $Branch"
        # Create the branch before checking it out, so a failure leaves the working tree untouched.
        $null = & git -C $InstallDir rev-parse --verify --quiet "refs/heads/$Branch"
        if ($LASTEXITCODE -ne 0) {
            Invoke-Native git @('-C', $InstallDir, 'branch', '--quiet', '--track', $Branch, "origin/$Branch") "Couldn't create the local branch $Branch"
        }
        Invoke-Native git @('-C', $InstallDir, 'checkout', '--quiet', $Branch) "Couldn't switch to $Branch"
    }

    & git -C $InstallDir merge --ff-only --quiet "origin/$Branch"
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Couldn't fast-forward to origin/$Branch (the clone has its own commits), so it wasn't updated."
    }
}

function Write-CommitInfo {
    if (-not (Get-Command git -ErrorAction SilentlyContinue) -or -not (Test-Path (Join-Path $InstallDir '.git'))) { return }
    $commit = & git -C $InstallDir log -1 --format='%h %s (%cr)'
    $headBranch = & git -C $InstallDir rev-parse --abbrev-ref HEAD
    if ($LASTEXITCODE -eq 0) { Write-Info "On $headBranch at commit $commit" }
}

function Sync-Source {
    if ($UseScriptRepo) {
        Write-Step 'Using the copy of the repository this script is in'
        Write-Info $InstallDir
        Write-Info "It's used as it is: nothing is downloaded, and your branch and changes are left alone."
        Write-Info 'To have the script download and update its own copy instead, pass -InstallDir <folder>.'
        Write-CommitInfo
        return
    }

    Write-Step "Getting the source ($Branch)"
    $isEmptyDir = (Test-Path $InstallDir) -and -not (Get-ChildItem -Force -LiteralPath $InstallDir | Select-Object -First 1)
    if (-not (Test-Path $InstallDir) -or $isEmptyDir) {
        Write-Info "Cloning $RepoUrl into $InstallDir"
        Invoke-Native git @('clone', '--branch', $Branch, '--single-branch', '--filter=blob:none', '-c', 'core.longpaths=true', $RepoUrl, $InstallDir) 'git clone failed'
    }
    elseif (-not (Test-Path (Join-Path $InstallDir '.git'))) {
        throw "$InstallDir already exists and isn't a git clone. Use -InstallDir to choose another folder, or delete it."
    }
    else {
        Update-Clone
    }

    if (-not (Test-Path (Join-Path $SandboxDir 'package.json'))) {
        throw "The Extensions Sandbox wasn't found at $SandboxDir. Check that '$Branch' is the right branch."
    }
    Write-CommitInfo
}

function Install-Dependencies {
    Write-Step 'Installing the sandbox dependencies'
    $lockFile = Join-Path $SandboxDir 'package-lock.json'
    $stampFile = [System.IO.Path]::Combine($SandboxDir, 'node_modules', '.extensions-sandbox-setup')
    # Reinstall whenever the lock file or the Node.js version changes (native bindings are per version).
    $nodeVersion = (& node --version | Select-Object -First 1).Trim()
    $expectedStamp = '{0} {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $lockFile).Hash.ToLowerInvariant(), $nodeVersion
    $currentStamp = if (Test-Path $stampFile) { (Get-Content -Raw -LiteralPath $stampFile).Trim() } else { '' }

    if (-not $ForceInstall -and $currentStamp -eq $expectedStamp) {
        Write-Info 'Dependencies are up to date.'
        return
    }

    Push-Location $SandboxDir
    try {
        Invoke-Native $Npm @('ci', '--no-audit', '--no-fund') "npm ci failed. Check your network or proxy settings, then run this script again"
    }
    finally {
        Pop-Location
    }
    Set-Content -LiteralPath $stampFile -Value $expectedStamp -Encoding Ascii -NoNewline
}

function Start-Sandbox {
    Write-Step 'Starting the Extensions Sandbox'
    Write-Info "Sandbox UI:  $SandboxUrl"
    Write-Info 'Press Ctrl+C to stop it (answer Y if asked to terminate the batch job).'

    $browserJob = $null
    if (-not $NoBrowser) {
        $browserJob = Start-Job -ArgumentList $SandboxUrl -ScriptBlock {
            param([string]$Url)
            $deadline = (Get-Date).AddMinutes(3)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 2
                try {
                    $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
                    Start-Process $Url
                    return
                }
                catch {
                    # Not up yet.
                }
            }
        }
    }

    Push-Location $SandboxDir
    try {
        & $Npm run dev
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "The sandbox stopped with exit code $LASTEXITCODE. Check the output above."
        }
    }
    finally {
        Pop-Location
        if ($browserJob) { Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Assert-Prerequisites
    if (-not $SetupOnly) { Assert-PortsFree }
    Sync-Source
    Install-Dependencies

    if ($SetupOnly) {
        Write-Step 'Setup complete'
        Write-Info 'Start the sandbox later by running this script again, or with:'
        Write-Info "  cd `"$SandboxDir`""
        Write-Info '  npm run dev'
        Write-Info "Then open $SandboxUrl."
        return
    }

    Start-Sandbox
}
catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
