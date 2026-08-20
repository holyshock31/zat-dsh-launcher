# ZAT-DSH Launcher

[English](./README.en.md) | **简体中文**

> 多终端 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面管理器：安装、启动、监控、更新、救援一条龙，**每个终端 100% 独立**，任何机器双击即用。

一个应用管理多个 Harness：每个终端独立端口、独立 DSH_HOME、独立日志、独立会话数据。删除一个终端不影响其他终端，运行中的终端互不干扰。

---

## 🌟 为什么选它

- **终端 100% 独立**：安装采用独立拷贝（非共享硬链接），删除/更新一个终端绝不影响其他终端——这是设计底线，不是口号
- **零依赖白板运行**：node / pnpm / npm / git 全部自动自举到用户目录，任何 Windows 机器双击即用，不需要预装任何东西
- **一键全新安装**：官方预构建包（npm registry 官方优先、国内镜像自动回退），零编译即装即跑，装完自动启动
- **安装位置自选**：首次安装先选文件夹（可新建），已有终端时直接装入已选目录
- **不弹黑窗**：隐藏控制台启动（CreateProcess 级），DSH 及其所有子进程都不弹黑色窗口
- **实时会话日志**：控制台实时显示每个对话的用户消息、助手完整回复、工具调用，带对话标题前缀，重命名实时同步
- **救援中心**：崩溃自动诊断（缺插件 / 配置损坏 / 启动参数不兼容等）+ 一键修复（排除插件 / 还原救援点 / 重新启动）
- **自动更新不翻车**：Harness 更新（git 源码 / npm 包双形态）失败自动回滚到旧版本，绝不留下半更新状态
- **内置插件市场**：zat-dsh-engine 自动注入、校验、回滚，插件升级一键完成
- **删除必删净**：停止进程 → 真实删除文件（实时进度）→ 清理日志/救援点/会话数据，删干净才提示完成，绝不留残留

## 🚀 安装方式

### 方式一：解压版（便携，免安装，推荐）

1. 前往 [Releases](https://github.com/mishibeikejie/zat-dsh-launcher/releases) 下载 `ZAT-DSH启动器-便携版-<版本>.zip`
2. 解压到任意目录，双击 `ZAT-DSH启动器.exe`
3. 首次使用：选择「一键全新安装」→ 选择安装位置 → 自动下载并启动第一个 Harness

### 方式二：安装版

1. 下载 `ZAT-DSH启动器 Setup <版本>.exe`
2. 运行安装，可选择安装目录、创建桌面快捷方式

### 方式三：从源码构建

```powershell
# 需要 Node.js 22+ 与 pnpm
pnpm install
pnpm test          # 运行 86 项单元测试
pnpm dist          # 打包（NSIS 安装版 + win-unpacked）
```

## 🧩 核心功能

| 能力 | 说明 |
| --- | --- |
| 多终端独立 | 独立端口 / DSH_HOME / 日志 / 注册表 / 会话数据，物理隔离 |
| 一键全新安装 | 官方预构建包，镜像回退，零编译，装完自动启动 |
| 自动扫描 / 手动接入 | 发现本机已安装或正在运行的 Harness，一键接入 |
| 隐藏控制台 | 子进程不弹黑色窗口 |
| 实时会话日志 | 完整对话内容 + 标题前缀，多对话一眼区分 |
| 救援中心 | 崩溃诊断 + 一键修复（排除插件 / 还原 / 重启） |
| 自动更新 | Harness 双形态更新，失败自动回滚；启动器自身更新检查 |
| 插件市场 | 内置 zat-dsh-engine，自动注入与更新 |
| 安全删除 | 真实删除 + 实时进度 + 残留自动清理，删干净才提示 |

## 🧩 架构

```
main.js                 Electron 主进程：终端生命周期 / IPC / 安装与更新编排
src/
  fresh-install.js      一键安装管道（官方包下载、镜像回退、工具链自举）
  terminal-registry.js  终端注册表（多实例合并、tombstone）
  terminal-supervisor.js 进程监控（隐藏控制台、崩溃自动重启）
  terminal-discovery.js 运行实例 / 磁盘扫描
  session-activity.js   会话活动提取（zstd 逐帧解析、流式碎片聚合）
  harness-update.js     Harness 更新（git 源码 / npm 包双形态 + 失败回滚）
  engine-manager.js     插件市场引擎（zat-dsh-engine）
  rescue.js             救援：崩溃诊断 / 救援点快照 / 还原
  cli-probe.js          DSH CLI 参数兼容性探测
  toolchain-execute.js  工具链执行器（node/pnpm/git 统一出口）
renderer/               渲染进程：控制台 / 环境 / 救援 / 向导界面
scripts/session-tail.cjs 会话增量读取 worker（隐藏控制台）
tests/                  86 项单元测试
```

### 终端独立性保证

- 安装采用 **copy 模式**：每个终端 `node_modules` 是独立物理拷贝（非 pnpm 硬链接），删除/更新互不影响
- 每终端独立端口分配、独立 `DSH_HOME`、独立日志目录、独立会话数据
- 删除终端 = 停止进程 + 删除登记 + 真实删除文件 + 清理日志/救援点，删干净才提示完成
- 共享路径（如默认 `~/.dsh`）有保护，绝不误删其他终端或用户数据

## 📦 版本

- [v1.0.0](https://github.com/mishibeikejie/zat-dsh-launcher/releases/tag/v1.0.0)：首个正式版。多终端独立、一键安装（位置自选）、隐藏控制台、实时会话日志、救援中心、自动更新、插件市场、安全删除。提供**安装版**与**解压版**两种发布物。

## 📄 License

[MIT](./LICENSE)

---

*DeepSeek Harness 为 [deepseek-ai](https://github.com/deepseek-ai) 项目；本启动器为独立开源工具，与其官方无关。*
