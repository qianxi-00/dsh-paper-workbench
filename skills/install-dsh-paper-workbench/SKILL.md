---
name: install-dsh-paper-workbench
description: Install, link, update, or verify the dsh-paper-workbench plugin inside DeepSeek Harness (DSH) Desktop or Web across Windows, macOS, and Linux — either via zero-clone 1-line installers (install.ps1 / install.sh) or local repository agent installer (install-agent.mjs).
---

# Install `dsh-paper-workbench` into DeepSeek Harness (DSH)

Choose **Path A (Zero-Clone One-Line Install)** when the user simply wants the plugin installed quickly without keeping a local git clone, or **Path B (Local Repository / Dev Mount)** when a local clone already exists or live code editing is desired. Always run dry-run preview first before modifying any DSH profile files.

## Path A: Zero-Clone One-Line Install (Recommended for End Users)

`dsh-paper-workbench` has **zero npm dependencies and zero build steps**, so the standalone scripts auto-detect `DSH_HOME` and target profile (`desktop` or `web`), back up `package.json` to `.bak`, extract the release tarball cleanly, and check `PyMuPDF`:

- **Windows (PowerShell 5.1+ / `pwsh` 7)**:
  ```powershell
  # 1) Preview first (no network download, no file writes)
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.ps1))) -DryRun
  # 2) Execute zero-clone install
  irm https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.ps1 | iex
  ```
- **macOS / Linux / Git Bash**:
  ```bash
  # 1) Preview first (no network download, no file writes)
  curl -fsSL https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.sh | bash -s -- --dry-run
  # 2) Execute zero-clone install
  curl -fsSL https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.sh | bash
  ```
- **DSH Web CLI** (when targeting `web` profile with `dsh` on PATH):
  ```bash
  dsh plugin --profile web add github:qianxi-00/dsh-paper-workbench
  ```

Optional flags for `install.ps1` / `install.sh`: `-Version` / `--version <v1.1.0>`, `-Profile` / `--profile <auto|desktop|web>`, `-DshHome` / `--dsh-home <path>`, `-SkipPyInstall` / `--skip-py-install`.

---

## Path B: Local Repository Install (`install-agent.mjs`)

### 1. Obtain or locate the repository

If working from a local checkout (or passing `--repo "<path>"`):

```bash
git clone https://github.com/qianxi-00/dsh-paper-workbench.git
cd dsh-paper-workbench
```

### 2. Preview with dry-run (`--dry-run --json`)

Run the zero-dependency cross-platform installer in preview mode first and parse its JSON output:

```bash
node scripts/install-agent.mjs --dry-run --json
```

Inspect the returned JSON before writing anything:

- `checks.node`: requires Node.js >= 20 (`22.5+` enables built-in `node:sqlite`; `20–22.4` falls back cleanly to JSON storage). Stop and tell the user if Node < 20.
- `checks.dsh`: auto-discovers `DSH_HOME` and platform defaults (`%LOCALAPPDATA%\DeepSeek Harness`, `%LOCALAPPDATA%\DSH`, `F:\ProGramApp\DSH`, `~/DSH`, `~/.dsh`).
  - If `checks.dsh.status === "not_found"`, ask the user for their DSH installation root and re-run with `--dsh-home "<path>"`.
- `checks.python`: probes for Python 3 with `import fitz` (PyMuPDF).
  - If `missing`, note whether the user wants automatic `pip install --user pymupdf` attempted or pass `--skip-py-install` in restricted/offline environments.
- Mode choice: default `--mode link` (live link to `--repo` for updates/dev) or `--mode copy` (standalone copy into `<DSH_HOME>/plugins/dsh-paper-workbench` and `profiles/desktop/node_modules`).

### 3. Execute installation (`--json`)

Once the dry-run plan looks right, run the installer without `--dry-run`:

```bash
node scripts/install-agent.mjs --json
```

Useful optional flags: `--dsh-home "<path>"`, `--repo "<path>"`, `--data-dir "<path>"`, `--workspace "<path>"`, `--mode link|copy`, `--skip-py-install`.

### 4. Verify runtime health (`doctor`)

```bash
node scripts/doctor.mjs
```

If `Python + PyMuPDF` reports `FAIL` / `missing`, give the user the exact 1-line OS command:
- **Windows**: `python -m pip install pymupdf` (or `winget install --id Python.Python.3.12` first)
- **macOS**: `python3 -m pip install --user pymupdf`
- **Linux**: `python3 -m pip install --user pymupdf`

---

## Report Status & Optional Post-Install Checks

Present a concise summary to the user covering installed path, `PyMuPDF` status, and these post-install items:

1. **Network Proxy** *(optional)* — for faster/reliable arXiv & OpenAlex access in restricted networks, configure HTTP / SOCKS5 proxy (e.g. `http://127.0.0.1:7897`) or enable system proxy auto-detection in workbench `⚙ 设置`.
2. **PaddleOCR Token** *(optional)* — only needed for scanned-PDF OCR and cloud `PP-StructureV3` layout parsing (`⚙ 设置 → 扫描件 OCR`).
3. **Optional Remote Database (PostgreSQL / MySQL)** *(optional)* — local SQLite (`workbench.db`) or JSON fallback works out of the box with zero setup; built-in zero-dependency PostgreSQL / MySQL clients can be enabled in `⚙ 设置` for team sharing or remote persistence.
4. **Optional Obsidian Vault** *(optional)* — opt-in toggle in `⚙ 设置` (`obsidian.enabled`) for paper cards and topic surveys.
5. **Enable / Reload `dsh-paper-workbench` in DSH** *(required to activate)* — reload/restart DSH Desktop (or `dsh web`), and ensure `dsh-paper-workbench` is enabled in **Settings → Plugins**.
