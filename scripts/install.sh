#!/usr/bin/env bash
# =============================================================================
# dsh-paper-workbench 零克隆一键安装脚本（macOS / Linux / Windows Git Bash）
#
# 利用本插件「零 npm 依赖、零构建步骤」优势，自动适配 DSH 桌面端（desktop）与 Web 端（web），
# 无需手动 git clone、无需编译原生依赖即可一步安装到位。
#
# 一行命令安装：
#   curl -fsSL https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.sh | bash
#
# 带参数调用示例：
#   curl -fsSL https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.sh | bash -s -- --version v1.1.0 --profile auto --dry-run
#   bash scripts/install.sh --version v1.1.0 --profile auto --dsh-home ~/.dsh --dry-run
# =============================================================================
set -euo pipefail

PKG="dsh-paper-workbench"
REPO="qianxi-00/dsh-paper-workbench"

VERSION_SPEC=""
PROFILE_NAME="auto"
EXPLICIT_DSH_HOME=""
DRY_RUN=false
SKIP_PY_INSTALL=false

print_help() {
  cat <<EOF
dsh-paper-workbench 一键安装脚本 (macOS / Linux / Git Bash)

用法：
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash
  bash scripts/install.sh [选项]

选项：
  --version <tag>       指定发布标签或版本（如 v1.1.0），缺省自动获取最新 Release（回退 main）
  --profile <name>      目标 profile：auto（默认自动识别 desktop/web）、desktop 或 web
  --dsh-home <path>     显式指定 DSH_HOME 目录（覆盖环境变量与自动探测）
  --dry-run             仅探测环境并打印预计执行的操作，不下载、不修改任何文件
  --skip-py-install     缺失 PyMuPDF 时不自动尝试 pip install，仅打印一行安装提示
  -h, --help            显示本帮助说明
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --skip-py-install)
      SKIP_PY_INSTALL=true
      ;;
    --version)
      [ $# -ge 2 ] || { echo "[error] --version 需要指定版本号（如 v1.1.0）" >&2; exit 2; }
      VERSION_SPEC="$2"
      shift
      ;;
    --version=*)
      VERSION_SPEC="${1#*=}"
      ;;
    --profile)
      [ $# -ge 2 ] || { echo "[error] --profile 需要指定名称（auto / desktop / web）" >&2; exit 2; }
      PROFILE_NAME="$2"
      shift
      ;;
    --profile=*)
      PROFILE_NAME="${1#*=}"
      ;;
    --dsh-home)
      [ $# -ge 2 ] || { echo "[error] --dsh-home 需要指定目录路径" >&2; exit 2; }
      EXPLICIT_DSH_HOME="$2"
      shift
      ;;
    --dsh-home=*)
      EXPLICIT_DSH_HOME="${1#*=}"
      ;;
    -*)
      echo "[error] 未知参数: $1（使用 --help 查看可用选项）" >&2
      exit 2
      ;;
    *)
      VERSION_SPEC="$1"
      ;;
  esac
  shift
done

say()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
info() { printf '\033[36m[info]   \033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]   \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[error]  \033[0m %s\n' "$*" >&2; exit 1; }

to_node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

# 1. 基础工具校验（Node.js >= 20 与 tar）
command -v node >/dev/null 2>&1 || die "未找到 node（DSH 与本安装器需要 Node.js >= 20）。请先安装 Node.js 20+ 并加入 PATH。"
NODE_VER="$(node -p 'process.versions.node' 2>/dev/null | tr -d '\r')"
NODE_MAJOR="${NODE_VER%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "无法解析 Node.js 版本: ${NODE_VER}" ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "当前 Node.js 版本 (v${NODE_VER}) 低于最低要求（>= 20.0.0），请升级 Node.js 20+（推荐 22.5+）。"
fi

command -v tar >/dev/null 2>&1 || die "未找到系统 tar 命令，请先安装 tar。"

# 2. 智能探测 DSH_HOME
HOME_DIR="${HOME:-${USERPROFILE:-$PWD}}"
has_profile_pkg() {
  local d="${1:-}"
  [ -n "$d" ] || return 1
  [ -f "$d/profiles/desktop/package.json" ] || [ -f "$d/profiles/web/package.json" ]
}

RESOLVED_DSH_HOME=""
DISCOVERED_BY=""
if [ -n "$EXPLICIT_DSH_HOME" ]; then
  RESOLVED_DSH_HOME="$EXPLICIT_DSH_HOME"
  DISCOVERED_BY="--dsh-home 参数"
elif [ -n "${DSH_HOME:-}" ]; then
  RESOLVED_DSH_HOME="$DSH_HOME"
  DISCOVERED_BY="DSH_HOME 环境变量"
else
  CANDIDATES=(
    "$HOME_DIR/.dsh"
  )
  if [ -n "${LOCALAPPDATA:-}" ]; then
    CANDIDATES+=("$LOCALAPPDATA/DeepSeek Harness" "$LOCALAPPDATA/DSH")
  fi
  if [ -n "${APPDATA:-}" ]; then
    CANDIDATES+=("$APPDATA/DeepSeek Harness" "$APPDATA/DSH")
  fi
  CANDIDATES+=(
    "F:/ProGramApp/DSH"
    "/f/ProGramApp/DSH"
    "$HOME_DIR/Library/Application Support/DeepSeek Harness"
    "$HOME_DIR/Library/Application Support/DSH"
    "${XDG_DATA_HOME:-$HOME_DIR/.local/share}/DeepSeek Harness"
    "${XDG_DATA_HOME:-$HOME_DIR/.local/share}/DSH"
    "$HOME_DIR/DSH"
  )
  for cand in "${CANDIDATES[@]}"; do
    if has_profile_pkg "$cand"; then
      RESOLVED_DSH_HOME="$cand"
      DISCOVERED_BY="自动探测"
      break
    fi
  done
  if [ -z "$RESOLVED_DSH_HOME" ]; then
    RESOLVED_DSH_HOME="$HOME_DIR/.dsh"
    DISCOVERED_BY="默认回退 (~/.dsh)"
  fi
fi

# 3. Profile 自动决策
HAS_DSH_CLI=false
if command -v dsh >/dev/null 2>&1; then
  HAS_DSH_CLI=true
fi

TARGET_PROFILE="$PROFILE_NAME"
if [ -z "$TARGET_PROFILE" ] || [ "$TARGET_PROFILE" = "auto" ]; then
  if [ -f "$RESOLVED_DSH_HOME/profiles/desktop/package.json" ]; then
    TARGET_PROFILE="desktop"
  elif [ -f "$RESOLVED_DSH_HOME/profiles/web/package.json" ] || { [ "$HAS_DSH_CLI" = true ] && [ -z "$EXPLICIT_DSH_HOME" ]; }; then
    TARGET_PROFILE="web"
  else
    TARGET_PROFILE="desktop"
  fi
fi

PROFILE_DIR="$RESOLVED_DSH_HOME/profiles/$TARGET_PROFILE"
PROFILE_PKG="$PROFILE_DIR/package.json"
WS_YAML="$PROFILE_DIR/pnpm-workspace.yaml"
PLUGINS_DIR="$RESOLVED_DSH_HOME/plugins/$PKG"
NM_PKG_DIR="$PROFILE_DIR/node_modules/$PKG"

info "Node.js        : v${NODE_VER}"
info "DSH_HOME       : ${RESOLVED_DSH_HOME} (${DISCOVERED_BY})"
info "Target Profile : ${TARGET_PROFILE} (${PROFILE_DIR})"

# 4. 解析版本与下载链接（dry-run 不发起任何网络请求）
NORM_TAG=""
NORM_VER=""
fetch_text() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 6 --max-time 12 -H "User-Agent: dsh-paper-workbench-installer" "$url" 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=10 --header="User-Agent: dsh-paper-workbench-installer" "$url" 2>/dev/null || true
  fi
}

download_file() {
  local url="$1"
  local out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 --max-time 90 -H "User-Agent: dsh-paper-workbench-installer" -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" --timeout=90 --header="User-Agent: dsh-paper-workbench-installer" "$url"
  else
    die "未找到 curl 或 wget，无法下载发布包。"
  fi
}

if [ -n "$VERSION_SPEC" ] && [ "$VERSION_SPEC" != "latest" ] && [ "$VERSION_SPEC" != "main" ]; then
  case "$VERSION_SPEC" in
    v*)
      NORM_TAG="$VERSION_SPEC"
      NORM_VER="${VERSION_SPEC#v}"
      ;;
    *)
      NORM_TAG="v${VERSION_SPEC}"
      NORM_VER="$VERSION_SPEC"
      ;;
  esac
elif [ "$DRY_RUN" = false ] && [ "$VERSION_SPEC" != "main" ]; then
  REL_JSON="$(fetch_text "https://api.github.com/repos/${REPO}/releases/latest")"
  if [ -n "$REL_JSON" ]; then
    PARSED_TAG="$(printf '%s' "$REL_JSON" | node -e '
      let d = "";
      process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j && typeof j.tag_name === "string") process.stdout.write(j.tag_name.trim());
        } catch {}
      });
    ' 2>/dev/null || true)"
    if [ -n "$PARSED_TAG" ]; then
      NORM_TAG="$PARSED_TAG"
      NORM_VER="${PARSED_TAG#v}"
    fi
  fi
fi

DOWNLOAD_URLS=()
if [ -n "$NORM_TAG" ] && [ -n "$NORM_VER" ]; then
  DOWNLOAD_URLS+=("https://github.com/${REPO}/releases/download/${NORM_TAG}/${PKG}-${NORM_VER}.tgz")
  DOWNLOAD_URLS+=("https://codeload.github.com/${REPO}/tar.gz/refs/tags/${NORM_TAG}")
fi
EXPECTED_VER=""
if [ -n "$VERSION_SPEC" ] && [ "$VERSION_SPEC" != "latest" ] && [ "$VERSION_SPEC" != "main" ]; then
  EXPECTED_VER="$NORM_VER"
else
  DOWNLOAD_URLS+=("https://codeload.github.com/${REPO}/tar.gz/refs/heads/main")
fi

# 5. Python + PyMuPDF (fitz) 探测与可选自动补装
PY_DETAIL=""
PY_HINT=""
check_pymupdf() {
  local allow_install="$1"
  local found_py3=""
  local py_cands=()
  [ -n "${DSH_PAPER_PYTHON:-}" ] && py_cands+=("$DSH_PAPER_PYTHON")
  [ -n "${PYTHON:-}" ] && py_cands+=("$PYTHON")
  [ -f "/f/ProGramApp/Anaconda/python.exe" ] && py_cands+=("/f/ProGramApp/Anaconda/python.exe")
  py_cands+=("python3" "python")

  for cand in "${py_cands[@]}"; do
    [ -n "$cand" ] || continue
    if ! command -v "$cand" >/dev/null 2>&1 && [ ! -x "$cand" ]; then
      continue
    fi
    local resolved_py=""
    resolved_py="$(command -v "$cand" 2>/dev/null || printf '%s' "$cand")"
    case "$resolved_py" in
      *WindowsApps/python*) continue ;;
    esac

    local probe=""
    probe="$("$cand" -c 'import fitz,sys;print(fitz.__doc__.split()[1]+"|"+sys.version.split()[0])' 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$probe" ] && [[ "$probe" == *"|"* ]]; then
      local fitz_v="${probe%%|*}"
      fitz_v="${fitz_v%:}"
      local py_v="${probe#*|}"
      PY_DETAIL="已就绪 (PyMuPDF ${fitz_v} · Python ${py_v})"
      PY_HINT=""
      return 0
    fi

    if [ -z "$found_py3" ]; then
      local ver3=""
      ver3="$("$cand" -c 'import sys;print(sys.version_info[0])' 2>/dev/null | tr -d '\r' || true)"
      if [ "$ver3" = "3" ]; then
        found_py3="$cand"
      fi
    fi
  done

  if [ "$allow_install" = true ] && [ -n "$found_py3" ]; then
    info "未检测到 PyMuPDF，正在尝试自动安装: ${found_py3} -m pip install -q pymupdf ..."
    if "$found_py3" -m pip install -q pymupdf >/dev/null 2>&1 || "$found_py3" -m pip install -q --user pymupdf >/dev/null 2>&1; then
      local recheck=""
      recheck="$("$found_py3" -c 'import fitz,sys;print(fitz.__doc__.split()[1]+"|"+sys.version.split()[0])' 2>/dev/null | tr -d '\r' || true)"
      if [ -n "$recheck" ] && [[ "$recheck" == *"|"* ]]; then
        local fitz_v="${recheck%%|*}"
        fitz_v="${fitz_v%:}"
        local py_v="${recheck#*|}"
        PY_DETAIL="已自动安装 (PyMuPDF ${fitz_v} · Python ${py_v})"
        PY_HINT=""
        return 0
      fi
    fi
  fi

  local pip_cmd="python3 -m pip install pymupdf"
  [ -n "$found_py3" ] && pip_cmd="${found_py3} -m pip install pymupdf"
  PY_DETAIL="未检测到 PyMuPDF（PDF 渲染与双语分段所需，不影响插件本身挂载）"
  PY_HINT="请执行一行命令补齐：${pip_cmd}"
}

USE_WEB_CLI=false
if [ "$TARGET_PROFILE" = "web" ] && [ "$HAS_DSH_CLI" = true ] && [ -z "$EXPECTED_VER" ]; then
  USE_WEB_CLI=true
fi

CLI_SPEC="github:${REPO}"
if [ -n "$NORM_TAG" ] && [ -n "$NORM_VER" ]; then
  CLI_SPEC="https://github.com/${REPO}/releases/download/${NORM_TAG}/${PKG}-${NORM_VER}.tgz"
fi

# 6. Dry-Run 预览（绝不下载或写入任何文件）
if [ "$DRY_RUN" = true ]; then
  say "[dry-run] 预览模式：不会下载发布包，也不会创建或修改任何文件。"
  if [ "$USE_WEB_CLI" = true ]; then
    if [ -f "$WS_YAML" ]; then
      say "[dry-run] 步骤 1：幂等确保 ${WS_YAML} 的 minimumReleaseAgeExclude 包含 ${PKG}"
    fi
    say "[dry-run] 步骤 2：设置 DSH_HOME=${RESOLVED_DSH_HOME} 并执行 dsh plugin --profile web add ${CLI_SPEC}"
  else
    say "[dry-run] 步骤 1：下载发布包（首选 ${DOWNLOAD_URLS[0]}）"
    say "[dry-run] 步骤 2：解压安装至 ${PLUGINS_DIR} 与 ${NM_PKG_DIR}"
    if [ -f "$PROFILE_PKG" ]; then
      say "[dry-run] 步骤 3：备份 ${PROFILE_PKG}.bak 并更新 dependencies[\"${PKG}\"] 与 dsh.profile.bundles"
    else
      say "[dry-run] 步骤 3：初始化 ${PROFILE_PKG} 并写入 dependencies[\"${PKG}\"] 与 dsh.profile.bundles"
    fi
    if [ -f "$WS_YAML" ]; then
      say "[dry-run] 步骤 4：幂等确保 ${WS_YAML} 的 minimumReleaseAgeExclude 包含 ${PKG}"
    fi
  fi
  check_pymupdf false
  say "[dry-run] PyMuPDF 状态：${PY_DETAIL}"
  [ -n "$PY_HINT" ] && warn "[dry-run] ${PY_HINT}"

  printf '\n'
  printf '┌──────────────────────────────────────────────────────────────┐\n'
  printf '│  dsh-paper-workbench · Dry-Run 预览通过（零文件改动）        │\n'
  printf '└──────────────────────────────────────────────────────────────┘\n'
  printf '  目标目录 : %s\n' "$PROFILE_DIR"
  printf '  PyMuPDF  : %s\n' "$PY_DETAIL"
  exit 0
fi

# 7. 正式执行零克隆安装
STAGE_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t pb-stage)"
cleanup() {
  rm -rf "$STAGE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

ensure_ws_exclude() {
  [ -f "$WS_YAML" ] || return 0
  local ws_js="$STAGE_DIR/patch-ws.js"
  cat >"$ws_js" <<'EOF'
const fs = require("node:fs");
const wsFile = process.argv[2];
const pkg = process.argv[3];
if (!fs.existsSync(wsFile)) process.exit(0);
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
}
EOF
  local out=""
  out="$(node "$(to_node_path "$ws_js")" "$(to_node_path "$WS_YAML")" "$PKG" | tr -d '\r')"
  [ "$out" = "updated" ] && say "已更新 ${WS_YAML} (minimumReleaseAgeExclude: ${PKG})" || true
}

INSTALLED_LABEL=""
USED_TARBALL=true
if [ "$USE_WEB_CLI" = true ]; then
  USED_TARBALL=false
  ensure_ws_exclude
  say "正在通过 DSH CLI 安装到 web profile: dsh plugin --profile web add ${CLI_SPEC} ..."
  if DSH_HOME="$RESOLVED_DSH_HOME" dsh plugin --profile web add "$CLI_SPEC"; then
    INSTALLED_LABEL="${PROFILE_DIR} (via dsh plugin add)"
  else
    warn "dsh plugin add 未成功，自动切换至零依赖直装通道..."
    USED_TARBALL=true
  fi
fi

if [ "$USED_TARBALL" = true ]; then
  TGZ_FILE="$STAGE_DIR/pkg.tgz"
  UNPACK_DIR="$STAGE_DIR/unpack"
  mkdir -p "$UNPACK_DIR"

  DOWNLOADED=false
  for url in "${DOWNLOAD_URLS[@]}"; do
    say "正在下载 ${url} ..."
    if download_file "$url" "$TGZ_FILE" && [ -s "$TGZ_FILE" ]; then
      DOWNLOADED=true
      break
    fi
    warn "从 ${url} 下载未成功，尝试备选源..."
  done

  if [ "$DOWNLOADED" != true ]; then
    die "无法下载 ${PKG} 发布包。若处于受限网络环境，请先配置 export https_proxy=http://127.0.0.1:7897 后重试。"
  fi

  say "正在解压并挂载插件文件（零 npm 依赖，免构建）..."
  (cd "$UNPACK_DIR" && tar -xzf - < "$TGZ_FILE")

  APPLY_JS="$STAGE_DIR/apply-install.js"
  cat >"$APPLY_JS" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const [unpackDir, pluginsDir, nmPkgDir, profilePkgPath, wsYamlPath, profileName, expectedVersion] = process.argv.slice(2);
const PKG = "dsh-paper-workbench";
const SKIP = new Set([".git", ".github", "node_modules", "dist", "__pycache__", ".DS_Store", "Thumbs.db"]);

function findExtractedRoot(dir) {
  if (fs.existsSync(path.join(dir, "package.json"))) return dir;
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
  fs.writeFileSync(profilePkgPath + ".bak", rawPkg, "utf8");
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

process.stdout.write(String(pkgMeta.version || "latest"));
EOF

  APPLIED_VER="$(node "$(to_node_path "$APPLY_JS")" \
    "$(to_node_path "$UNPACK_DIR")" \
    "$(to_node_path "$PLUGINS_DIR")" \
    "$(to_node_path "$NM_PKG_DIR")" \
    "$(to_node_path "$PROFILE_PKG")" \
    "$(to_node_path "$WS_YAML")" \
    "$TARGET_PROFILE" "$EXPECTED_VER" | tr -d '\r')"

  INSTALLED_LABEL="${PLUGINS_DIR} (v${APPLIED_VER#v})"
  say "已挂载插件包并安全更新 ${PROFILE_PKG}（已生成 .bak 备份）"
fi

ALLOW_PY_INSTALL=true
[ "$SKIP_PY_INSTALL" = true ] && ALLOW_PY_INSTALL=false
check_pymupdf "$ALLOW_PY_INSTALL"
if [ -n "$PY_HINT" ]; then
  warn "$PY_HINT"
fi

printf '\n'
printf '┌──────────────────────────────────────────────────────────────────────┐\n'
printf '│  ✓ dsh-paper-workbench 安装完成（零 npm 依赖 · 免克隆）              │\n'
printf '└──────────────────────────────────────────────────────────────────────┘\n'
printf '  安装位置 : %s\n' "$INSTALLED_LABEL"
printf '  Profile  : %s (%s)\n' "$TARGET_PROFILE" "$PROFILE_PKG"
printf '  PyMuPDF  : %s\n' "$PY_DETAIL"
if [ -n "$PY_HINT" ]; then
  printf '             -> %s\n' "$PY_HINT"
fi
printf '\n'
printf '  下一步生效操作：\n'
if [ "$TARGET_PROFILE" = "desktop" ]; then
  printf '  1. 重启或重载 DSH 桌面端（若已开启，可在「设置 → 插件」停用再启用 dsh-paper-workbench）\n'
else
  printf '  1. 重启 dsh web 服务并刷新浏览器页面（Ctrl+Shift+R / Cmd+Shift+R）\n'
fi
printf '  2. 点击左侧导航「论文工作台」，可在「⚙ 设置」按需配置可选项：\n'
printf '     · 网络代理（支持 HTTP / SOCKS5 / 自动探测本机代理如 127.0.0.1:7897）\n'
printf '     · PaddleOCR Token（仅扫描件 OCR 与 PP-StructureV3 云端版面解析需要）\n'
printf '     · 外部数据库（内置 SQLite 开箱即用；可选切换 PostgreSQL / MySQL）\n'
printf '     · Obsidian 联动（按需开启知识库卡片与方向综述同步）\n'
