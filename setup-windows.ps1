#Requires -Version 5.1
<#
.SYNOPSIS
    Provisions a fresh Windows machine to run Warp (this app).

.DESCRIPTION
    Installs, in order: Git (optional but recommended), Node.js LTS, the
    Claude Code CLI, then runs `npm install` and the DB init script inside
    this project. Every step is wrapped so one failure doesn't kill the
    whole run — it's recorded and the script moves on, then prints a
    pass/fail summary at the end.

    There is no separate "database server" to install. This app uses
    SQLite via better-sqlite3 — a file (`data.db`), not a service. The only
    reason a native compiler toolchain (Python + Visual Studio Build
    Tools) might be needed at all is if npm can't find a prebuilt
    better-sqlite3 binary for your exact Node version and has to compile
    it from source. Rather than always installing a multi-GB build
    toolchain up front, this script tries the plain `npm install` first
    and only reaches for Python / Build Tools if npm's own output shows
    that's actually why it failed — see Invoke-NpmInstall below.

    KNOWN GAP THIS SCRIPT WORKS AROUND: claude-runner.js's claudeBin()
    only searches macOS/Linux paths (/opt/homebrew/bin/claude,
    /usr/local/bin/claude, ~/.claude/local/claude) — there is no Windows
    path in that list, so the app cannot find the CLI on its own here yet.
    It does honor a CLAUDE_BIN environment variable, though, so this
    script sets that (persistently, for your user account) once it knows
    where the installer put claude.exe.

.PARAMETER ProjectPath
    Path to the app's root (the folder with package.json). Defaults to
    this script's own folder, since it's meant to live at the project root.

.PARAMETER SkipClaudeLogin
    Claude Code needs an interactive browser login on first use. This
    script never attempts that (there is nothing to script around an
    OAuth flow) — it just tells you to run `claude` yourself afterward.
    This switch is only about suppressing that reminder, not the login
    itself.

.EXAMPLE
    .\setup-windows.ps1
    Run from an elevated PowerShell prompt in the project folder.
#>

[CmdletBinding()]
param(
    [string]$ProjectPath = $PSScriptRoot,
    [switch]$SkipClaudeLogin
)

Set-StrictMode -Version Latest

# ============================================================
# SMALL HELPERS
# ============================================================

$Script:Results = [System.Collections.Generic.List[object]]::new()

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  OK  $Message" -ForegroundColor Green
}

function Write-Skip {
    param([string]$Message)
    Write-Host "  --  $Message" -ForegroundColor DarkYellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  !!  $Message" -ForegroundColor Red
}

<#
    Runs one provisioning step and records its outcome for the final
    summary, so one failure doesn't kill the whole run. This is the outer
    try/catch every step goes through; the "known error -> do the
    necessary thing" reaction itself lives closer to where the error
    actually happens — see Invoke-NpmInstall below, which is the one step
    that genuinely has more than one recognizable failure mode worth
    reacting to differently. Everything else here either succeeds, is
    already satisfied (checked explicitly inside $Action), or fails in a
    way there's nothing more specific to do about than report it.
#>
function Invoke-Step {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [scriptblock]$Action,
        [switch]$Optional
    )

    Write-Step $Name
    try {
        & $Action
        Write-Ok $Name
        $Script:Results.Add([pscustomobject]@{ Step = $Name; Status = 'OK'; Detail = '' })
        return $true
    } catch {
        $errMsg = $_.Exception.Message
        if ($Optional) {
            Write-Skip "$Name — $errMsg"
            $Script:Results.Add([pscustomobject]@{ Step = $Name; Status = 'SKIPPED (optional)'; Detail = $errMsg })
            return $false
        }
        Write-Fail "$Name — $errMsg"
        $Script:Results.Add([pscustomobject]@{ Step = $Name; Status = 'FAILED'; Detail = $errMsg })
        return $false
    }
}

<#
    winget wraps external exit codes, not exceptions — every winget call
    goes through here so a non-zero exit becomes a catchable error instead
    of silently succeeding on the next line.
#>
function Install-WingetPackage {
    param(
        [Parameter(Mandatory)] [string]$Id,
        [string[]]$ExtraArgs = @()
    )

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is not available on this machine. Install 'App Installer' from the Microsoft Store, then re-run this script."
    }

    $args = @('install', '--id', $Id, '--exact', '--silent',
              '--accept-package-agreements', '--accept-source-agreements') + $ExtraArgs
    & winget @args | Out-Host
    # winget returns 0 for a fresh install and -1978335189 (0x8A15002B) for
    # "already installed, nothing to do" — both are fine here.
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        throw "winget install of '$Id' exited with code $LASTEXITCODE"
    }
}

function Test-IsAdministrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = [Security.Principal.WindowsPrincipal]::new($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ============================================================
# 0. SANITY CHECKS
# ============================================================

if (-not (Test-Path (Join-Path $ProjectPath 'package.json'))) {
    Write-Fail "No package.json found under '$ProjectPath'."
    Write-Host "Pass -ProjectPath, or run this script from the project root." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-IsAdministrator)) {
    Write-Host "Not running as Administrator." -ForegroundColor Yellow
    Write-Host "winget will still prompt (UAC) for anything that genuinely needs elevation" -ForegroundColor Yellow
    Write-Host "(Build Tools, mainly) — but for the smoothest run, re-launch this script" -ForegroundColor Yellow
    Write-Host "from an elevated PowerShell prompt." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Setting up Warp in: $ProjectPath" -ForegroundColor White

# ============================================================
# 1. GIT (optional — recommended for Claude Code's Bash tool, not required
#    to run the app itself)
# ============================================================

Invoke-Step -Name "Git for Windows" -Optional -Action {
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Host "  already installed: $(git --version)"
        return
    }
    Install-WingetPackage -Id 'Git.Git'
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git installed but not on PATH yet — open a new PowerShell window and re-run if anything below needs it."
    }
}

# ============================================================
# 2. NODE.JS — LTS. Claude Code's own npm-install path wants Node 22+; this
#    app has no engines field pinning a version, so the same LTS covers both.
# ============================================================

Invoke-Step -Name "Node.js LTS" -Action {
    $existing = Get-Command node -ErrorAction SilentlyContinue
    if ($existing) {
        $ver = (node --version)
        Write-Host "  already installed: $ver"
        $major = [int]($ver.TrimStart('v').Split('.')[0])
        if ($major -lt 22) {
            Write-Host "  Node $ver is older than the recommended 22 — Claude Code's npm-based" -ForegroundColor Yellow
            Write-Host "  install path in particular wants 22+. Not replacing it automatically" -ForegroundColor Yellow
            Write-Host "  (that can break other projects pinned to this version) — upgrade by" -ForegroundColor Yellow
            Write-Host "  hand if the Claude Code install step below fails because of it." -ForegroundColor Yellow
        }
        return
    }
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS'
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js installed but not on PATH in this session — open a new PowerShell window and re-run."
    }
    Write-Host "  installed: $(node --version)"
}

# ============================================================
# 3. CLAUDE CODE CLI — native installer first (no Node-version dependency
#    of its own), npm as the fallback.
# ============================================================

Invoke-Step -Name "Claude Code CLI" -Action {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Host "  already installed: $(claude --version)"
        return
    }

    try {
        Write-Host "  trying the native installer..."
        Invoke-Expression (Invoke-RestMethod https://claude.ai/install.ps1)
    } catch {
        Write-Host "  native installer failed ($($_.Exception.Message)) — falling back to npm" -ForegroundColor Yellow
        & npm install -g @anthropic-ai/claude-code | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "both the native installer and 'npm install -g @anthropic-ai/claude-code' failed"
        }
    }

    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        throw "claude was installed but isn't on PATH in this session — open a new PowerShell window and re-run to finish (CLAUDE_BIN step below needs to find it)."
    }
}

# claude-runner.js's claudeBin() (see this file's own header) has no
# Windows paths at all — CLAUDE_BIN is the only way it can find the CLI
# here, so this app-specific fix-up runs regardless of which install path
# above actually worked.
Invoke-Step -Name "Point the app at the Claude CLI (CLAUDE_BIN)" -Optional -Action {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "claude is not on PATH — the app will not find it without CLAUDE_BIN set by hand later."
    }
    $resolved = $cmd.Source
    [Environment]::SetEnvironmentVariable('CLAUDE_BIN', $resolved, 'User')
    $env:CLAUDE_BIN = $resolved
    Write-Host "  CLAUDE_BIN set to $resolved (persisted for your user account)"
}

# ============================================================
# 4. npm install — with reactive recovery for the one native module
#    (better-sqlite3) that can require a C++ toolchain to build from
#    source if no prebuilt binary matches this Node version.
# ============================================================

function Invoke-NpmInstall {
    param([string]$ProjectPath)

    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        Write-Host "  npm install (attempt $attempt of $maxAttempts)..."
        $output = & npm install --prefix "`"$ProjectPath`"" 2>&1 | Out-String
        Write-Host $output

        if ($LASTEXITCODE -eq 0) {
            return
        }

        if ($output -match 'find Python|Python was not found|Can''t find Python executable|gyp ERR!.*Python') {
            Write-Host "  Detected: node-gyp can't find Python. Installing Python 3..." -ForegroundColor Yellow
            Install-WingetPackage -Id 'Python.Python.3.12'
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                        [Environment]::GetEnvironmentVariable('Path', 'User')
            continue
        }

        if ($output -match 'find VS|Visual Studio|MSB[0-9]{4}|VCBuildTools|MSBUILD') {
            Write-Host "  Detected: node-gyp can't find a C++ build toolchain. Installing Visual Studio Build Tools (this step is large and can take a while)..." -ForegroundColor Yellow
            Install-WingetPackage -Id 'Microsoft.VisualStudio.2022.BuildTools' `
                -ExtraArgs @('--override', '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
            continue
        }

        if ($output -match 'ENOTFOUND|ETIMEDOUT|ECONNRESET|network') {
            Write-Host "  Detected a network error — waiting 5s and retrying." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
            continue
        }

        if ($output -match 'EBADENGINE') {
            # A warning, not the actual failure cause — the real error is
            # elsewhere in $output, which was already printed above.
            Write-Host "  (an EBADENGINE warning appeared too, but that alone doesn't fail the install)" -ForegroundColor DarkGray
        }

        throw "npm install failed for a reason this script doesn't recognize — see the output above."
    }

    throw "npm install still failing after $maxAttempts attempts."
}

Invoke-Step -Name "npm install (project dependencies)" -Action {
    Invoke-NpmInstall -ProjectPath $ProjectPath
}

# ============================================================
# 5. INITIALIZE THE LOCAL DATABASE — a file (data.db), not a service. See
#    scripts/init-db.mjs's own header for why this has to run once, by
#    itself, before anything else touches the DB.
# ============================================================

Invoke-Step -Name "Initialize data.db" -Action {
    Push-Location $ProjectPath
    try {
        & node scripts/init-db.mjs | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "node scripts/init-db.mjs exited with code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# ============================================================
# 6. gong.env — cannot be scripted (it's a Gong session cookie + CX Portal
#    token, both secrets only you can supply). Just flag whether it exists.
# ============================================================

Invoke-Step -Name "gong.env present" -Optional -Action {
    $envPath = Join-Path $ProjectPath 'gong.env'
    if (-not (Test-Path $envPath)) {
        throw "gong.env does not exist yet. Create it and fill in GONG_HOST / GONG_COOKIE at minimum — see README.md's Setup section for the full field list. The app will not start without it (gong.js's loadConfig() throws if it's missing)."
    }
    Write-Host "  found: $envPath"
}

# ============================================================
# SUMMARY
# ============================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor White
Write-Host " Summary" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White
foreach ($r in $Script:Results) {
    $color = switch -Wildcard ($r.Status) {
        'OK' { 'Green' }
        'SKIPPED*' { 'DarkYellow' }
        default { 'Red' }
    }
    Write-Host ("  {0,-45} {1}" -f $r.Step, $r.Status) -ForegroundColor $color
}

$failed = $Script:Results | Where-Object { $_.Status -eq 'FAILED' }
Write-Host ""
if ($failed) {
    Write-Host "$($failed.Count) step(s) failed — fix those and re-run this script; already-satisfied steps are skipped automatically." -ForegroundColor Red
} else {
    Write-Host "All required steps completed." -ForegroundColor Green
}

Write-Host ""
Write-Host "Still needed by hand, always:" -ForegroundColor White
if (-not $SkipClaudeLogin) {
    Write-Host "  - Run 'claude' once and complete the browser login — there is no way to script an OAuth flow." -ForegroundColor White
}
Write-Host "  - Fill in gong.env if the step above flagged it missing (README.md's Setup table)." -ForegroundColor White
Write-Host "  - Open a NEW PowerShell window before running npm scripts, so PATH and CLAUDE_BIN pick up everything this script just set." -ForegroundColor White
Write-Host ""
Write-Host "Then: npm run dev   (http://127.0.0.1:7878)" -ForegroundColor White
