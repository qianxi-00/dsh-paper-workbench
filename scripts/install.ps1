## =============================================================================
# dsh-paper-workbench 零克隆一键安装脚本（Windows PowerShell 5.1+ / pwsh 7+）
#
# 利用本插件「零 npm 依赖、零构建步骤」优势，自动适配 DSH 桌面端（desktop）与 Web 端（web），
# 无需手动 git clone、无需 pnpm 编译依赖即可一步安装到位。
#
# 一行命令安装（Windows PowerShell / pwsh）：
#   irm https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.ps1 | iex
#
# 带参数调用示例：
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.ps1))) -Version v1.1.0 -Profile auto -DryRun
#   pwsh -File scripts/install.ps1 -Version v1.1.0 -Profile auto -DshHome "D:\DSH" -DryRun
# =============================================================================
param(
  [string]$Version = '',
  [string]$Profile = 'auto',
  [string]$DshHome = '',
  [switch]$DryRun,
  [switch]$SkipPyInstall,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$PKG = 'dsh-paper-workbench'
$REPO = 'qianxi-00/dsh-paper-workbench'

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # PowerShell Core / 非 Windows 平台已默认启用现代 TLS
}

function Say([string]$Msg)  { Write-Host "[install] $Msg" -ForegroundColor Green }
function Info([string]$Msg) { Write-Host "[info]    $Msg" -ForegroundColor Cyan }
function Warn([string]$Msg) { Write-Host "[warn]    $Msg" -ForegroundColor Yellow }
function Die([string]$Msg) {
  Write-Host "[error]   $Msg" -ForegroundColor Red
  if ([string]::IsNullOrEmpty($MyInvocation.ScriptName) -and [string]::IsNullOrEmpty($PSCommandPath)) {
    throw $Msg
  }
  exit 1
}

function Join-Parts([string[]]$Parts) {
  return [System.IO.Path]::Combine($Parts)
}

function Write-Utf8NoBom([string]$FilePath, [string]$Content) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($FilePath, $Content, $enc)
}

if ($Help) {
  Write-Host @"
dsh-paper-workbench 一键安装脚本 (PowerShell 5.1+ / pwsh 7+)

用法：
  irm https://raw.githubusercontent.com/$REPO/main/scripts/install.ps1 | iex
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$REPO/main/scripts/install.ps1))) [参数]

参数：
  -Version <tag>     指定发布标签或版本（如 v1.1.0），缺省自动获取最新 Release（回退 main）
  -Profile <name>    目标 profile：auto（默认自动识别 desktop/web）、desktop 或 web
  -DshHome <path>    显式指定 DSH_HOME 目录（覆盖环境变量与自动探测）
  -DryRun            仅探测环境并打印预计执行的操作，不下载、不修改任何文件
  -SkipPyInstall     缺失 PyMuPDF 时不自动尝试 pip install，仅打印一行安装提示
  -Help              显示本帮助说明
"@
  $global:LASTEXITCODE = 0
  return
}

# 1. 基础工具校验（Node.js >= 20 与 tar）
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Die '未找到 node（DSH 与本安装器需要 Node.js >= 20）。请先安装 Node.js 20+ 并加入 PATH。'
}
$nodeVerRaw = (& node -p "process.versions.node" 2>$null | Out-String).Trim()
$nodeMajor = 0
if (-not [int]::TryParse(($nodeVerRaw -split '\.')[0], [ref]$nodeMajor) -or $nodeMajor -lt 20) {
  Die "当前 Node.js 版本 ($nodeVerRaw) 低于最低要求（>= 20.0.0），请升级 Node.js 20+（推荐 22.5+）。"
}

$tarCmd = Get-Command tar -ErrorAction SilentlyContinue
if (-not $tarCmd) {
  Die '未找到系统 tar 命令（Windows 10/11、macOS 与主流 Linux 均内置 tar），请检查 PATH。'
}

# 2. 智能探测 DSH_HOME
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { [Environment]::GetFolderPath('UserProfile') }

function Test-HasProfilePkg([string]$CandidateDir) {
  if ([string]::IsNullOrWhiteSpace($CandidateDir)) { return $false }
  $deskPkg = Join-Parts @($CandidateDir, 'profiles', 'desktop', 'package.json')
  $webPkg  = Join-Parts @($CandidateDir, 'profiles', 'web', 'package.json')
  return (Test-Path -LiteralPath $deskPkg) -or (Test-Path -LiteralPath $webPkg)
}

$resolvedDshHome = ''
$discoveredBy = ''
if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
  $resolvedDshHome = [System.IO.Path]::GetFullPath($DshHome)
  $discoveredBy = '-DshHome 参数'
} elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  $resolvedDshHome = [System.IO.Path]::GetFullPath($env:DSH_HOME)
  $discoveredBy = 'DSH_HOME 环境变量'
} else {
  $dotDsh = Join-Parts @($homeDir, '.dsh')
  $candidates = @($dotDsh)
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Parts @($env:LOCALAPPDATA, 'DeepSeek Harness'))
    $candidates += (Join-Parts @($env:LOCALAPPDATA, 'DSH'))
  }
  if ($env:APPDATA) {
    $candidates += (Join-Parts @($env:APPDATA, 'DeepSeek Harness'))
    $candidates += (Join-Parts @($env:APPDATA, 'DSH'))
  }
  $candidates += 'F:\ProGramApp\DSH'
  $candidates += (Join-Parts @($homeDir, 'Library', 'Application Support', 'DeepSeek Harness'))
  $candidates += (Join-Parts @($homeDir, 'Library', 'Application Support', 'DSH'))
  $candidates += (Join-Parts @($homeDir, '.local', 'share', 'DSH'))
  $candidates += (Join-Parts @($homeDir, 'DSH'))

  foreach ($cand in $candidates) {
    if (Test-HasProfilePkg $cand) {
      $resolvedDshHome = [System.IO.Path]::GetFullPath($cand)
      $discoveredBy = '自动探测'
      break
    }
  }
  if (-not $resolvedDshHome) {
    $resolvedDshHome = [System.IO.Path]::GetFullPath($dotDsh)
    $discoveredBy = '默认回退 (~/.dsh)'
  }
}

# 3. Profile 自动决策
$dshCli = Get-Command dsh -ErrorAction SilentlyContinue
$deskPkgPath = Join-Parts @($resolvedDshHome, 'profiles', 'desktop', 'package.json')
$webPkgPath  = Join-Parts @($resolvedDshHome, 'profiles', 'web', 'package.json')

$targetProfile = $Profile
if ([string]::IsNullOrWhiteSpace($targetProfile) -or $targetProfile.ToLowerInvariant() -eq 'auto') {
  if (Test-Path -LiteralPath $deskPkgPath) {
    $targetProfile = 'desktop'
  } elseif ((Test-Path -LiteralPath $webPkgPath) -or ($null -ne $dshCli -and [string]::IsNullOrWhiteSpace($DshHome))) {
    $targetProfile = 'web'
  } else {
    $targetProfile = 'desktop'
  }
}

$profileDir = Join-Parts @($resolvedDshHome, 'profiles', $targetProfile)
$profilePkg = Join-Parts @($profileDir, 'package.json')
$wsYaml     = Join-Parts @($profileDir, 'pnpm-workspace.yaml')
$pluginsDir = Join-Parts @($resolvedDshHome, 'plugins', $PKG)
$nmPkgDir   = Join-Parts @($profileDir, 'node_modules', $PKG)

Info "Node.js        : v$nodeVerRaw"
Info "DSH_HOME       : $resolvedDshHome ($discoveredBy)"
Info "Target Profile : $targetProfile ($profileDir)"

# 4. 解析版本与下载源（DryRun 不发起网络请求）
$normTag = ''
$normVer = ''
if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -ne 'latest' -and $Version -ne 'main') {
  if ($Version.StartsWith('v')) {
    $normTag = $Version
    $normVer = $Version.Substring(1)
  } else {
    $normTag = "v$Version"
    $normVer = $Version
  }
} elseif (-not $DryRun -and $Version -ne 'main') {
  try {
    $relApi = "https://api.github.com/repos/$REPO/releases/latest"
    $relResp = Invoke-RestMethod -Uri $relApi -Headers @{ 'User-Agent' = 'dsh-paper-workbench-installer' } -TimeoutSec 8 -ErrorAction Stop
    if ($relResp -and $relResp.tag_name) {
      $normTag = [string]$relResp.tag_name
      $normVer = $normTag -replace '^v', ''
    }
  } catch {
    # GitHub API 受限或离线时静默回退 main 源码包
  }
}

$downloadUrls = @()
if ($normTag -and $normVer) {
  $downloadUrls += "https://github.com/$REPO/releases/download/$normTag/$PKG-$normVer.tgz"
  $downloadUrls += "https://codeload.github.com/$REPO/tar.gz/refs/tags/$normTag"
}
$expectedVersion = ''
if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -ne 'latest' -and $Version -ne 'main') {
  $expectedVersion = $normVer
} else {
  $downloadUrls += "https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
}

# 辅助函数：通过临时 .js 文件交由 node 执行（规避 PS 5.1 node -e 双引号吞字 bug）
function Invoke-NodeTempScript([string]$JsSource, [string[]]$ScriptArgs) {
  $tmpJs = Join-Parts @([System.IO.Path]::GetTempPath(), ("pb-inst-" + [guid]::NewGuid().ToString('N') + '.js'))
  try {
    Write-Utf8NoBom $tmpJs $JsSource
    $out = & node $tmpJs @ScriptArgs 2>&1
    $code = $LASTEXITCODE
    $text = (($out | Out-String)).Trim()
    if ($code -ne 0) {
      Die "Node 脚本执行失败 (exit $code): $text"
    }
    return $text
  } finally {
    Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
  }
}

$wsPatchJs = @'
const fs = require("node:fs");
const wsFile = process.argv[2];
const pkg = process.argv[3];
if (!fs.existsSync(wsFile)) {
  console.log("absent");
  process.exit(0);
}
let text = fs.readFileSync(wsFile, "utf8");
const before = text;
const itemRe = new RegExp("^\\s*-\\s*['\"]?" + pkg.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "(?:@[^\\s'\"]+)?['\"]?\\s*$", "m");
if (!itemRe.test(text)) {
  if (/^\s*minimumReleaseAgeExclude:\s*$/m.test(text)) {
    text = text.replace(/^(\s*minimumReleaseAgeExclude:\s*)$/m, "$1\n  - " + pkg);
  } else {
    text = text.replace(/\s*$/, "\nminimumReleaseAgeExclude:\n  - " + pkg + "\n");
  }
}
if (text !== before) {
  fs.writeFileSync(wsFile, text, "utf8");
  console.log("updated");
} else {
  console.log("unchanged");
}
'@

$tarballApplyJs = @'
const fs = require("node:fs");
const path = require("node:path");

const [unpackDir, pluginsDir, nmPkgDir, profilePkgPath, wsYamlPath, profileName, expectedVersion] = process.argv.slice(2);
const PKG = "dsh-paper-workbench";
const SKIP = new Set([".git", ".github", "node_modules", "dist", "__pycache__", ".DS_Store", "Thumbs.db"]);

function findExtractedRoot(dir) {
  const directPkg = path.join(dir, "package.json");
  if (fs.existsSync(directPkg)) return dir;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const sub = path.join(dir, ent.name);
      if (fs.existsSync(path.join(sub, "package.json"))) return sub;
    }
  }
  throw new Error("解压包内未找到 package.json: " + dir);
}

function safeRemove(target) {
  let st = null;
  try { st = fs.lstatSync(target); } catch { st = null; }
  if (!st) return;
  if (st.isSymbolicLink()) fs.unlinkSync(target);
  else fs.rmSync(target, { recursive: true, force: true });
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(ent.name) || ent.name.endsWith(".pyc") || ent.name.endsWith(".tmp")) continue;
    if (/^\.env(\.|$)/.test(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

const srcRoot = findExtractedRoot(unpackDir);
const pkgMeta = JSON.parse(fs.readFileSync(path.join(srcRoot, "package.json"), "utf8"));
if (pkgMeta.name !== PKG) {
  throw new Error("下载包名称不匹配: " + pkgMeta.name);
}

if (expectedVersion && (typeof pkgMeta.version !== "string" || pkgMeta.version.replace(/^v/, "") !== expectedVersion)) {
  throw new Error("下载包版本不匹配：要求 " + expectedVersion + "，实际 " + pkgMeta.version + "。安装未修改，请核对发布包后重试。");
}

safeRemove(pluginsDir);
copyTree(srcRoot, pluginsDir);

fs.mkdirSync(path.dirname(nmPkgDir), { recursive: true });
safeRemove(nmPkgDir);
copyTree(srcRoot, nmPkgDir);

fs.mkdirSync(path.dirname(profilePkgPath), { recursive: true });
let rawPkg = "";
let parsed = null;
if (fs.existsSync(profilePkgPath)) {
  rawPkg = fs.readFileSync(profilePkgPath, "utf8");
  const bakPath = profilePkgPath + ".bak";
  fs.writeFileSync(bakPath, rawPkg, "utf8");
  parsed = JSON.parse(rawPkg);
} else {
  parsed = {
    name: "dsh-profile-" + (profileName || "desktop"),
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } }
  };
}

const indentMatch = rawPkg.match(/\n([ \t]+)"/);
const indent = indentMatch ? indentMatch[1] : "  ";

if (!parsed.dependencies || typeof parsed.dependencies !== "object") parsed.dependencies = {};
parsed.dependencies[PKG] = "file:../../plugins/" + PKG;

if (!parsed.dsh || typeof parsed.dsh !== "object") parsed.dsh = {};
if (!parsed.dsh.profile || typeof parsed.dsh.profile !== "object") parsed.dsh.profile = {};
if (!Array.isArray(parsed.dsh.profile.bundles)) parsed.dsh.profile.bundles = [];
if (!parsed.dsh.profile.bundles.includes(PKG)) {
  parsed.dsh.profile.bundles.push(PKG);
}

const tmpOut = profilePkgPath + ".tmp-" + process.pid;
fs.writeFileSync(tmpOut, JSON.stringify(parsed, null, indent) + "\n", "utf8");
fs.renameSync(tmpOut, profilePkgPath);

if (wsYamlPath && fs.existsSync(wsYamlPath)) {
  let ws = fs.readFileSync(wsYamlPath, "utf8");
  const before = ws;
  if (!/^\s*-\s*['"]?dsh-paper-workbench(?:@[^\s'"]+)?['"]?\s*$/m.test(ws)) {
    if (/^\s*minimumReleaseAgeExclude:\s*$/m.test(ws)) {
      ws = ws.replace(/^(\s*minimumReleaseAgeExclude:\s*)$/m, "$1\n  - dsh-paper-workbench");
    } else {
      ws = ws.replace(/\s*$/, "\nminimumReleaseAgeExclude:\n  - dsh-paper-workbench\n");
    }
  }
  if (ws !== before) fs.writeFileSync(wsYamlPath, ws, "utf8");
}

console.log(JSON.stringify({ version: pkgMeta.version || "", pluginsDir, nmPkgDir, profilePkgPath }));
'@

# 5. Python + PyMuPDF (fitz) 检测与可选安装
function Test-PyMuPdf([bool]$AllowInstall) {
  $pyCandidates = @()
  if ($env:DSH_PAPER_PYTHON) { $pyCandidates += $env:DSH_PAPER_PYTHON }
  if ($env:PYTHON)           { $pyCandidates += $env:PYTHON }
  if (Test-Path -LiteralPath 'F:\ProGramApp\Anaconda\python.exe') {
    $pyCandidates += 'F:\ProGramApp\Anaconda\python.exe'
  }
  $pyCandidates += @('python', 'python3', 'py')

  $foundPy3 = ''
  foreach ($cand in $pyCandidates) {
    if ([string]::IsNullOrWhiteSpace($cand)) { continue }
    $cmdObj = if ([System.IO.Path]::IsPathRooted($cand)) {
      if (Test-Path -LiteralPath $cand) { $cand } else { $null }
    } else {
      $c = Get-Command $cand -ErrorAction SilentlyContinue
      if ($c -and $c.Source -notlike '*\WindowsApps\python*.exe') { $c.Source } elseif ($c -and (Test-Path -LiteralPath $c.Source) -and (Get-Item -LiteralPath $c.Source).Length -gt 0) { $c.Source } else { $null }
    }
    if (-not $cmdObj) { continue }

    try {
      $probe = (& $cmdObj -c "import fitz,sys;print(fitz.__doc__.split()[1]+'|'+sys.version.split()[0])" 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and $probe -like '*|*') {
        $parts = $probe -split '\|'
        $fitzV = ($parts[0] -replace ':+$', '')
        return @{ Status = 'ok'; Detail = "已就绪 (PyMuPDF $fitzV · Python $($parts[1]))"; Hint = '' }
      }
      if (-not $foundPy3) {
        $verProbe = (& $cmdObj -c "import sys;print(sys.version_info[0])" 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $verProbe -eq '3') {
          $foundPy3 = $cmdObj
        }
      }
    } catch {
      continue
    }
  }

  if ($AllowInstall -and $foundPy3) {
    Info "未检测到 PyMuPDF，正在尝试自动执行: $foundPy3 -m pip install -q pymupdf ..."
    try {
      & $foundPy3 -m pip install -q pymupdf 2>$null
      if ($LASTEXITCODE -ne 0) {
        & $foundPy3 -m pip install -q --user pymupdf 2>$null
      }
      $recheck = (& $foundPy3 -c "import fitz,sys;print(fitz.__doc__.split()[1]+'|'+sys.version.split()[0])" 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and $recheck -like '*|*') {
        $parts = $recheck -split '\|'
        $fitzV = ($parts[0] -replace ':+$', '')
        return @{ Status = 'ok'; Detail = "已自动安装 (PyMuPDF $fitzV · Python $($parts[1]))"; Hint = '' }
      }
    } catch {
      # 不阻断插件安装
    }
  }

  $pipCmd = if ($foundPy3) { "`"$foundPy3`" -m pip install pymupdf" } else { 'python -m pip install pymupdf' }
  return @{
    Status = 'missing'
    Detail = '未检测到 PyMuPDF（PDF 渲染与双语分段所需，不影响插件本身挂载）'
    Hint   = "请执行一行命令补齐：$pipCmd"
  }
}

$useWebCli = ($targetProfile -eq 'web') -and ($null -ne $dshCli) -and (-not $expectedVersion)
$cliSpec = if ($normTag -and $normVer) {
  "https://github.com/$REPO/releases/download/$normTag/$PKG-$normVer.tgz"
} else {
  "github:$REPO"
}

# 6. DryRun 预览（绝不下载或写入任何文件）
if ($DryRun) {
  Say "[dry-run] 预览模式：不会下载发布包，也不会创建或修改任何文件。"
  if ($useWebCli) {
    if (Test-Path -LiteralPath $wsYaml) {
      Say "[dry-run] 步骤 1：幂等确保 $wsYaml 的 minimumReleaseAgeExclude 包含 $PKG"
    }
    Say "[dry-run] 步骤 2：设置 DSH_HOME=$resolvedDshHome 并执行 dsh plugin --profile web add $cliSpec"
  } else {
    Say "[dry-run] 步骤 1：下载发布包（首选 $($downloadUrls[0])）"
    Say "[dry-run] 步骤 2：解压安装至 $pluginsDir 与 $nmPkgDir"
    if (Test-Path -LiteralPath $profilePkg) {
      Say "[dry-run] 步骤 3：备份 $profilePkg.bak 并更新 dependencies[`"$PKG`"] 与 dsh.profile.bundles"
    } else {
      Say "[dry-run] 步骤 3：初始化 $profilePkg 并写入 dependencies[`"$PKG`"] 与 dsh.profile.bundles"
    }
    if (Test-Path -LiteralPath $wsYaml) {
      Say "[dry-run] 步骤 4：幂等确保 $wsYaml 的 minimumReleaseAgeExclude 包含 $PKG"
    }
  }
  $pyInfo = Test-PyMuPdf -AllowInstall $false
  Say "[dry-run] PyMuPDF 状态：$($pyInfo.Detail)"
  if ($pyInfo.Hint) { Warn "[dry-run] $($pyInfo.Hint)" }

  Write-Host ""
  Write-Host "┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Cyan
  Write-Host "│  dsh-paper-workbench · Dry-Run 预览通过（零文件改动）        │" -ForegroundColor Cyan
  Write-Host "└──────────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
  Write-Host "  目标目录 : $profileDir"
  Write-Host "  PyMuPDF  : $($pyInfo.Detail)"
  $global:LASTEXITCODE = 0
  return
}

# 7. 正式执行零克隆安装
$installedLabel = ''
$usedTarball = (-not $useWebCli)

if ($useWebCli) {
  if (Test-Path -LiteralPath $wsYaml) {
    $wsRes = Invoke-NodeTempScript $wsPatchJs @($wsYaml, $PKG)
    if ($wsRes -eq 'updated') { Say "已更新 $wsYaml (minimumReleaseAgeExclude: $PKG)" }
  }
  Say "正在通过 DSH CLI 安装到 web profile: dsh plugin --profile web add $cliSpec ..."
  $prevDshHome = $env:DSH_HOME
  try {
    $env:DSH_HOME = $resolvedDshHome
    & dsh plugin --profile web add $cliSpec
    if ($LASTEXITCODE -eq 0) {
      $installedLabel = "$profileDir (via dsh plugin add)"
    } else {
      Warn "dsh plugin add 返回退出码 $LASTEXITCODE，自动切换至零依赖直装通道..."
      $usedTarball = $true
    }
  } catch {
    Warn "dsh plugin add 调用异常 ($($_.Exception.Message))，自动切换至零依赖直装通道..."
    $usedTarball = $true
  } finally {
    $env:DSH_HOME = $prevDshHome
  }
}

if ($usedTarball) {
  $stageDir = Join-Parts @([System.IO.Path]::GetTempPath(), ("pb-stage-" + [guid]::NewGuid().ToString('N')))
  $tgzFile  = Join-Parts @($stageDir, 'pkg.tgz')
  $unpackDir = Join-Parts @($stageDir, 'unpack')
  New-Item -ItemType Directory -Path $unpackDir -Force | Out-Null
  try {
    $downloaded = $false
    $lastErr = ''
    foreach ($url in $downloadUrls) {
      try {
        Say "正在下载 $url ..."
        Invoke-WebRequest -Uri $url -OutFile $tgzFile -Headers @{ 'User-Agent' = 'dsh-paper-workbench-installer' } -UseBasicParsing -TimeoutSec 60
        if ((Test-Path -LiteralPath $tgzFile) -and (Get-Item -LiteralPath $tgzFile).Length -gt 512) {
          $downloaded = $true
          break
        }
      } catch {
        $lastErr = $_.Exception.Message
        Warn "从 $url 下载未成功，尝试备选源..."
      }
    }
    if (-not $downloaded) {
      Die "无法下载 $PKG 发布包（$lastErr）。若处于受限网络环境，请先配置 `$env:HTTPS_PROXY='http://127.0.0.1:7897'` 后重试。"
    }

    Say '正在解压并挂载插件文件（零 npm 依赖，免构建）...'
    & tar -xzf $tgzFile -C $unpackDir
    if ($LASTEXITCODE -ne 0) {
      Die "tar 解压失败（退出码 $LASTEXITCODE）。"
    }

    $applyJson = Invoke-NodeTempScript $tarballApplyJs @($unpackDir, $pluginsDir, $nmPkgDir, $profilePkg, $wsYaml, $targetProfile, $expectedVersion)
    $applied = $applyJson | ConvertFrom-Json
    $verShow = if ($applied.version) { "v$($applied.version)" } else { 'latest' }
    $installedLabel = "$pluginsDir ($verShow)"
    Say "已挂载插件包并安全更新 $profilePkg（已生成 .bak 备份）"
  } finally {
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$pyResult = Test-PyMuPdf -AllowInstall (-not $SkipPyInstall)
if ($pyResult.Hint) {
  Warn $pyResult.Hint
}

Write-Host ""
Write-Host "┌──────────────────────────────────────────────────────────────────────┐" -ForegroundColor Green
Write-Host "│  ✓ dsh-paper-workbench 安装完成（零 npm 依赖 · 免克隆）              │" -ForegroundColor Green
Write-Host "└──────────────────────────────────────────────────────────────────────┘" -ForegroundColor Green
Write-Host "  安装位置 : $installedLabel"
Write-Host "  Profile  : $targetProfile ($profilePkg)"
Write-Host "  PyMuPDF  : $($pyResult.Detail)"
if ($pyResult.Hint) {
  Write-Host "             -> $($pyResult.Hint)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  下一步生效操作：" -ForegroundColor Cyan
if ($targetProfile -eq 'desktop') {
  Write-Host "  1. 重启或重载 DSH 桌面端（若已开启，可在「设置 → 插件」停用再启用 dsh-paper-workbench）"
} else {
  Write-Host "  1. 重启 dsh web 服务并刷新浏览器页面（Ctrl+Shift+R / Cmd+Shift+R）"
}
Write-Host "  2. 点击左侧导航「论文工作台」，可在「⚙ 设置」按需配置可选项："
Write-Host "     · 网络代理（支持 HTTP / SOCKS5 / 自动探测本机代理如 127.0.0.1:7897）"
Write-Host "     · PaddleOCR Token（仅扫描件 OCR 与 PP-StructureV3 云端版面解析需要）"
Write-Host "     · 外部数据库（内置 SQLite 开箱即用；可选切换 PostgreSQL / MySQL）"
Write-Host "     · Obsidian 联动（按需开启知识库卡片与方向综述同步）"
$global:LASTEXITCODE = 0
