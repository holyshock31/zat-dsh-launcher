# ZAT-DSH Launcher

**English** | [简体中文](./README.md)

> A multi-terminal [DeepSeek Harness](https://github.com/deepseek-ai) desktop manager for Windows: install, run, monitor, update and rescue multiple Harness instances — **each terminal is 100% independent**, zero dependencies, double-click to use.

Manage many Harness instances from one app: each terminal has its own port, DSH_HOME, logs, registry and session data. Deleting one terminal never affects the others; running terminals never interfere with each other.

---

## 🌟 Highlights

- **100% independent terminals**: installations use physical copies (not shared hard links) — deleting or updating one terminal never touches the others. This is a design guarantee, not a slogan.
- **Zero-dependency, works anywhere**: node / pnpm / npm / git are all bootstrapped automatically into the user directory. No preinstalled toolchain required on any Windows machine.
- **One-click fresh install**: official prebuilt packages (npm registry first, China mirrors as automatic fallback), zero compilation, ready to run, auto-starts after install.
- **Choose your install location**: first install prompts you to pick a folder (or create a new one); when a terminal already exists, it installs straight into the chosen directory.
- **No black console windows**: hidden-console launch (CreateProcess-level), DSH and all its child processes never pop up console windows.
- **Live session logs**: the console streams each conversation's user messages, full assistant replies and tool calls in real time, prefixed with the conversation title (renames sync instantly).
- **Rescue center**: automatic crash diagnosis (missing plugins / broken config / incompatible CLI args…) with one-click fixes (exclude plugin / restore snapshot / restart).
- **Updates that never break**: Harness updates (git source & npm package forms) roll back automatically on failure — no half-updated state is ever left behind.
- **Built-in plugin market**: zat-dsh-engine is injected, verified and rolled back automatically; plugin upgrades are one click.
- **Deletion that really deletes**: stop processes → physically delete files (live progress) → clean logs/snapshots/session data. Success is only reported when everything is truly gone.

## 🚀 Installation

### Option 1: Portable ZIP (no install, recommended)

1. Download `ZAT-DSH启动器-便携版-<version>.zip` from [Releases](https://github.com/mishibeikejie/zat-dsh-launcher/releases)
2. Extract anywhere and double-click `ZAT-DSH启动器.exe`
3. First run: choose "一键全新安装" → pick an install location → the first Harness is downloaded and started automatically

### Option 2: Installer

1. Download `ZAT-DSH启动器 Setup <version>.exe`
2. Run it; you can choose the install directory and create a desktop shortcut

### Option 3: Build from source

```powershell
# Requires Node.js 22+ and pnpm
pnpm install
pnpm test          # runs the 86 unit tests
pnpm dist          # builds the NSIS installer + win-unpacked
```

## 🧩 Feature Overview

| Capability | Description |
| --- | --- |
| Independent terminals | Per-terminal port / DSH_HOME / logs / registry / session data, physically isolated |
| One-click install | Official prebuilt packages, mirror fallback, zero compilation, auto-start |
| Auto scan / manual attach | Detect installed or running Harness instances and attach with one click |
| Hidden console | No black windows for DSH or its children |
| Live session logs | Full conversation content + title prefixes, multiple conversations at a glance |
| Rescue center | Crash diagnosis + one-click fix (exclude plugin / restore / restart) |
| Auto update | Dual-form Harness updates with automatic rollback; launcher self-update check |
| Plugin market | Built-in zat-dsh-engine, auto-injected and updated |
| Safe deletion | Real deletion + live progress + automatic residue cleanup; success only when clean |

## 🧩 Architecture

```
main.js                 Electron main process: lifecycle / IPC / install & update orchestration
src/
  fresh-install.js      Fresh-install pipeline (official package, mirror fallback, toolchain bootstrap)
  terminal-registry.js  Terminal registry (multi-instance merge, tombstones)
  terminal-supervisor.js Process supervision (hidden console, crash auto-restart)
  terminal-discovery.js Running-instance / disk scanning
  session-activity.js   Session activity extraction (per-frame zstd, streamed chunk aggregation)
  harness-update.js     Harness updates (git source & npm package, rollback on failure)
  engine-manager.js     Plugin-market engine (zat-dsh-engine)
  rescue.js             Rescue: crash diagnosis / snapshots / restore
  cli-probe.js          DSH CLI argument compatibility probing (--no-open etc.)
  toolchain-execute.js  Toolchain executor (single exit for node/pnpm/git)
renderer/               Renderer: console / environment / rescue / wizard UI
scripts/session-tail.cjs Session incremental reader worker (hidden console)
tests/                  86 unit tests
```

### Independence Guarantees

- Installations use **copy mode**: each terminal's `node_modules` is a physical copy (not pnpm hard links) — delete/update never interferes
- Per-terminal port allocation, `DSH_HOME`, log directory and session data
- Deleting a terminal = stop processes + remove registration + physically delete files + clean logs/snapshots; success is only reported when everything is gone
- Shared paths (e.g. default `~/.dsh`) are protected from accidental deletion

## 📦 Releases

- [v1.0.0](https://github.com/mishibeikejie/zat-dsh-launcher/releases/tag/v1.0.0): first stable release. Independent terminals, one-click install (location selectable), hidden console, live session logs, rescue center, auto updates, plugin market, safe deletion. Ships as **installer** and **portable ZIP**.

## 📄 License

[MIT](./LICENSE)

---

*DeepSeek Harness is a project of [deepseek-ai](https://github.com/deepseek-ai); this launcher is an independent open-source tool, not affiliated with it.*
