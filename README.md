# ZAT-DSH Launcher

多终端 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面管理器 —— 安装、启动、监控、更新、救援一条龙，**每个终端 100% 独立**，任何机器双击即用。

> 一个应用管理多个 Harness：每个终端独立的端口、独立的 DSH_HOME、独立的日志、独立的会话数据。删除一个终端不会影响其他终端，运行中的终端互不干扰。

---

## ✨ 功能

| 能力 | 说明 |
| --- | --- |
| **多终端独立** | 每终端独立端口 / DSH_HOME / 日志 / 注册表 / 会话数据，物理隔离（独立拷贝，非共享链接） |
| **一键全新安装** | 下载官方预构建包（npm registry 官方优先、国内镜像回退），零编译即装即跑，装完自动启动 |
| **安装位置自选** | 首次安装先选文件夹（可新建），已有终端时直接装入已选目录 |
| **自动扫描 / 手动接入** | 一键发现本机已安装或正在运行的 Harness，或手动选择目录接入 |
| **隐藏控制台启动** | 子进程不弹黑色窗口（CreateProcess + 隐藏控制台，与官方终端等效） |
| **实时会话日志** | 控制台实时显示每个对话的用户消息 / 助手回复 / 工具调用，带对话标题前缀 |
| **救援中心** | 崩溃自动诊断（缺插件 / 配置损坏 / 启动参数不兼容等）+ 一键修复（排除插件 / 还原救援点 / 重新启动） |
| **自动更新** | Harness 更新（git 源码 / npm 包双形态，失败自动回滚）与启动器自身更新检查 |
| **插件市场** | 内置 zat-dsh-engine 插件市场，自动注入与更新 |
| **白板原则** | 不依赖机器预装任何东西：node / pnpm / npm / git 全部自动自举到用户目录 |

## 🚀 快速开始

### Windows 用户（免安装）

1. 从 [Releases](https://github.com/<your-repo>/zat-dsh-launcher/releases) 下载 `ZAT-DSH启动器-便携版-<版本>.zip`
2. 解压后双击 `ZAT-DSH启动器.exe`
3. 首次使用：选择「一键全新安装」→ 选择安装位置 → 自动下载并启动第一个 Harness

### 从源码构建

```powershell
# 需要 Node.js 22+ 与 pnpm
pnpm install
pnpm test          # 运行测试
pnpm dist          # 打包（NSIS 安装包 + win-unpacked）
```

打包产物位于 `dist/`：`ZAT-DSH启动器 Setup <版本>.exe`（安装包）与便携版目录。

## 🧩 架构

```
main.js                 Electron 主进程：终端生命周期 / IPC / 安装与更新编排
src/                    业务模块
  fresh-install.js      一键安装管道（官方包下载、镜像回退、工具链自举）
  terminal-registry.js  终端注册表（多实例合并、tombstone）
  terminal-supervisor.js 进程监控（隐藏控制台、崩溃自动重启）
  terminal-discovery.js 运行实例 / 磁盘扫描
  session-activity.js   会话活动提取（zstd 逐帧解析、流式碎片聚合）
  harness-update.js     Harness 更新（git 源码 / npm 包双形态 + 失败回滚）
  engine-manager.js     插件市场引擎（zat-dsh-engine）
  rescue.js             救援：崩溃诊断 / 救援点快照 / 还原
  cli-probe.js          DSH CLI 参数兼容性探测（--no-open 等）
  toolchain-execute.js  工具链执行器（node/pnpm/git 统一出口）
renderer/               渲染进程：控制台 / 环境 / 救援 / 向导界面
scripts/session-tail.cjs 会话增量读取 worker（系统 node 执行，隐藏控制台）
tests/                  单元测试（终端隔离、删除安全、会话解析、参数探测等）
```

### 终端独立性保证

- 安装采用 **copy 模式**：每个终端的 `node_modules` 是独立物理拷贝（非 pnpm 硬链接），删除/更新互不影响
- 每终端独立端口分配、独立 `DSH_HOME`、独立日志目录、独立会话数据
- 删除终端 = 停止进程 + 删除登记 + 真实删除文件 + 清理日志/救援点，删干净才提示完成
- 共享路径（如默认 `~/.dsh`）有保护，绝不误删其他终端或用户数据

## 📦 发布

每个版本 bump `package.json version` 与 `main.js APP_VERSION`（版本隔离的数据目录随版本切换，白板打开）。便携版 zip 使用 `Compress-Archive`（保留中文文件名）。

## 📄 License

[MIT](./LICENSE)

---

*DeepSeek Harness 为 [deepseek-ai](https://github.com/deepseek-ai) 项目；本启动器为独立开源工具，与其官方无关。*
