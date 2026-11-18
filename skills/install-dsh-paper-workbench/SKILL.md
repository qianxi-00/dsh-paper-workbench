---
name: install-dsh-paper-workbench
description: Install, link, update, or verify the dsh-paper-workbench plugin inside DeepSeek Harness (DSH) Desktop across Windows, macOS, and Linux. Use when a user asks an AI Coding Agent to set up dsh-paper-workbench, connect a local clone or release package to DSH, or troubleshoot Python/PyMuPDF and DSH plugin registration.
---

# Install `dsh-paper-workbench` into DeepSeek Harness (DSH)

Follow these steps in order. Do not skip the dry-run preview, and never overwrite or fabricate DSH paths without verifying `profiles/desktop/package.json` exists.

## 1. Obtain or update the repository

If `dsh-paper-workbench` is not yet on disk, clone it (or extract the release `.tgz` tarball from GitHub Releases):

```bash
git clone https://github.com/qianxi-00/dsh-paper-workbench.git
cd dsh-paper-workbench
```

If already cloned, confirm the working tree is at the desired branch/tag before proceeding.

## 2. Preview with dry-run (`--dry-run --json`)

Run the zero-dependency cross-platform installer in preview mode first and parse its JSON output:

```bash
node scripts/install-agent.mjs --dry-run --json
```

Inspect the returned JSON before writing anything:

- `checks.node`: requires Node.js >= 20 (`22.5+` enables built-in `node:sqlite`; `20–22.4` falls back cleanly to JSON storage). Stop and tell the user if Node < 20.
- `checks.dsh`: auto-discovers `DSH_HOME` and platform defaults (`F:\ProGramApp\DSH`, `%LOCALAPPDATA%\DSH`, `~/DSH`, `~/.dsh`).
  - If `checks.dsh.status === "not_found"`, ask the user for their DSH installation root and re-run with `--dsh-home "<path>"`.
- `checks.python`: probes for Python 3 with `import fitz` (PyMuPDF).
  - If `missing`, note whether the user wants automatic `pip install --user pymupdf` attempted or pass `--skip-py-install` in restricted/offline environments.
- Mode choice: default `--mode link` (live link to repo for updates/dev) or `--mode copy` (standalone copy into `<DSH_HOME>/plugins/dsh-paper-workbench` and `profiles/desktop/node_modules`).

## 3. Execute installation (`--json`)

Once the dry-run plan looks right, run the installer without `--dry-run`:

```bash
node scripts/install-agent.mjs --json
```

Useful optional flags:

- `--dsh-home "<path>"` — explicit DSH Home containing `profiles/desktop/package.json`
- `--data-dir "<path>"` — custom data directory (default `$DSH_PAPER_WORKBENCH_DATA` or `~/.dsh/paper-workbench`)
- `--workspace "<path>"` — target workspace directory (for preparing workspace / syncing `assets/workspace-skills/` when present)
- `--mode link|copy` — install mode (`link` or `copy`)
- `--skip-py-install` — only check `fitz`, do not attempt `pip install pymupdf`

Confirm the command exits `0` and returns `"ok": true` with:
- `profiles/desktop/package.json.bak` created before updating `dependencies["dsh-paper-workbench"]`
- All existing fields and dependencies in `profiles/desktop/package.json` preserved
- `checks.dsh.nodeModulesStatus` is `linked`, `already_linked`, or `copied`

## 4. Verify runtime health (`doctor`)

Run the repository environment check to confirm everything works together:

```bash
node scripts/doctor.mjs
```

If `Python + PyMuPDF` reports `FAIL` / `missing` (e.g., no system Python or PEP 668 externally-managed environment), give the user the exact OS command rather than forcing system flags:

- **Windows (PowerShell)**: `winget install --id Python.Python.3.12` then `python -m pip install pymupdf`
- **macOS**: `brew install python` then `python3 -m pip install --user pymupdf`
- **Linux (Debian/Ubuntu)**: `sudo apt install python3 python3-pip` then `python3 -m pip install --user pymupdf`

## 5. Report status and remaining user options

Present a concise summary built directly from the JSON report (`writtenFiles`, `checks`, `todos`, and `optionalUserConfigs`):

1. **Installed / Verified**:
   - DSH Home path, `dependencies["dsh-paper-workbench"]` entry, `.bak` backup file path, `node_modules` mount status, data directory, Node/SQLite status, and Python/PyMuPDF status.
2. **Remaining User Options & Required Final Action**:
   1. **PaddleOCR Token** *(optional)* — only needed for scanned-PDF OCR and cloud `PP-StructureV3` layout parsing (configure in workbench `⚙ 设置 → 扫描件 OCR`).
   2. **Optional Remote Database (PostgreSQL / MySQL)** *(optional)* — `dsh-paper-workbench` works out of the box using local SQLite (`workbench.db`) or JSON fallback (`workbench.json`); built-in zero-dependency PostgreSQL / MySQL protocol clients can be enabled in `config.json` (`database.driver` / connection fields) if team sharing or remote persistence is desired.
   3. **Optional Obsidian Vault** *(optional)* — auto-detected when Obsidian is open, or configurable in `⚙ 设置` for paper cards and topic surveys.
   4. **Enable / Restart `dsh-paper-workbench` in DSH Plugin Manager** *(required to activate UI/server)* — open DSH Desktop → **Settings → Plugins**, enable `dsh-paper-workbench` (or disable → re-enable if already running), and restart DSH Desktop if `checks.dsh.pluginEnableStatus` is not `enabled`.
