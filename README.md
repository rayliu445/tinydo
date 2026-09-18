
TinyDo 是一款对标滴答清单的个人任务管理工具，支持多平台运行和用户自管数据。

## 界面预览

**主界面** — 今天视图（未完成/已完成分组）+ 右侧第四列详情面板：

![今天视图](docs/screenshots/home.png)

**收集箱** — 任务列表 + 父子任务层级 + 任务详情：

![收集箱](docs/screenshots/inbox.png)

**笔记** — 笔记管理（任务/笔记分离、归档）：

![笔记](docs/screenshots/notes.png)

**日历** — 月视图（支持周/日视图）：

![日历](docs/screenshots/calendar.png)

## 功能

- 📅 **日历视图** — 月视图 / 周视图 / 日视图，快速添加任务
- 🔲 **四象限矩阵** — 艾森豪威尔矩阵，手动分类 + 自动规则分类
- 📥 **滴答清单导入** — 支持 CSV / JSON 格式导入历史数据
- 💾 **本地持久化** — IndexedDB + localStorage 双备份，数据不丢失
- 🌙 **暗黑模式** — 亮色 / 暗黑 / 跟随系统
- 🔄 **WebDAV 云同步** — 连接坚果云、NextCloud 等，多端数据互通
- ✏️ **任务管理** — 添加 / 编辑 / 删除 / 搜索 / 优先级 / 截止日期
- ⚙️ **设置页面** — 数据导出导入、云存储配置、主题切换
- 🤖 **外部助手（DSH / CLI）** — 本地桥接接口（协议 `api: 1`），配合独立仓库 [tinydo-agent](https://github.com/rayliu445/tinydo-agent) 的 `tinydo` CLI 与 DSH 原生工具使用

## 外部助手（DSH / CLI）

桌面端在 `127.0.0.1` 上开放一个带 token 的本地接口，让 DSH 等外部 Agent 直接读写任务
（App 始终是唯一写入者：界面实时刷新、云同步照常、每次写入留审计）。

**客户端（`tinydo` CLI + DSH 插件 + 客户端库）在独立仓库：**
[rayliu445/tinydo-agent](https://github.com/rayliu445/tinydo-agent) —— 它只依赖本接口，不依赖本仓库代码。
接口契约见 `docs/agent-bridge-design.md`；两边各自独立发版。

```bash
# 命令行（人 / 脚本 / 任意 Agent 都能用；装在 tinydo-agent 里）
npx tinydo-agent list --today
npx tinydo-agent add "写周报" --due 明天 --priority high
npx tinydo-agent doctor           # App / 端口 / token / 数据层自检

# DSH 原生工具（9 个 tinydo_*，安装后重启 DSH）
cd ~/.dsh/profiles/web
pnpm add tinydo-agent
# 把 "tinydo-agent" 加进 dsh.profile.bundles

# 本仓库自检（App 侧，自包含、不依赖客户端代码）
npm run selftest          # 本地接口协议契约
npm run selftest:bridge   # 桥接主进程单元测试
npm run selftest:agent    # 顺带跑 tinydo-agent 的两套端到端（需克隆到同级目录）
```

开关在「设置 → 外部助手」（可随时关闭、吊销 token、查看写入记录）。
决策记录：`docs/adr/0004-external-agent-bridge.md`。

## 平台

| 平台 | 安装包 | 技术 |
|------|--------|------|
| 🖥️ macOS | `.dmg` | Electron 30（未签名，首次安装见下方说明） |
| 🖥️ Windows | `.exe` (Portable) | Electron 30 |
| 📱 iOS | `.ipa` (Sideloadly 侧载) | Capacitor 8（未签名，免费侧载） |
| 📱 Android | `.apk` | Capacitor 8 |
| 🌐 Web | 浏览器直接访问 | Vite 2 |

完整安装指南请查看 [docs/INSTALL.md](docs/INSTALL.md)。

### macOS 首次安装说明

TinyDo 为**未签名应用**，macOS 首次打开可能提示「无法验证开发者」或「已损坏，无法打开」（Gatekeeper 误报，并非应用损坏）。请使用 DMG 内的安装脚本：

1. 打开 DMG
2. 双击 **`fix-gatekeeper.command`**
3. 在弹出的对话框中点击**打开**（仅首次需要）
4. 输入你的 Mac 密码
5. 脚本自动完成：复制到 Applications → 解除系统拦截 → 启动应用

> **如果脚本本身也被提示「不安全/已损坏」**：右键 → 打开 → 打开（仅一次）。
> 脚本运行后会**先对自己执行 `xattr` 解除隔离**，之后再双击即正常。
>
> macOS 15+ (Sequoia) 对未签名应用限制更严格，无法通过右键→打开绕过，必须用脚本或命令处理。
> 在终端手动执行：
> ```bash
> xattr -cr /Applications/TinyDo.app && open /Applications/TinyDo.app
> ```
>
> **覆盖安装不会丢失数据**：任务数据和同步配置保存在
> `~/Library/Application Support/tinydo/`（应用外部），重装后原样保留、无需重新配置。
>
> 完整注意事项见 [docs/INSTALL.md](docs/INSTALL.md)。

## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | Vue 3 (Composition API + `<script setup>`) |
| 语言 | TypeScript |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 (Hash 模式) |
| 样式 | Tailwind CSS 3 + 自定义 CSS 变量主题 |
| 桌面端 | Electron 30 + electron-builder |
| 移动端 | Capacitor 8 |
| 数据存储 | SQLite (sql.js) + IndexedDB 持久化 |
| 云同步 | 七牛云 Kodo (对象存储) |
| 构建工具 | Vite 2 |

## 数据架构

```
用户数据 → SQLite (sql.js) → IndexedDB 持久化
                           → 七牛云 Kodo 同步（可选）
                           → 完全本地优先，用户自主管理数据
```

所有数据存储在本地，用户可选配七牛云 Kodo 实现多端云同步，
无需注册任何第三方服务平台。

## 快速开始

```bash
# 开发模式
npm install
npm run dev
# 访问 http://localhost:3000

# 构建桌面端
npm run dist          # macOS .dmg
# 或
npm run electron:build  # 构建但不打包

# 构建移动端 (需要 Xcode / Android SDK)
npm run mobile:build:ios       # iOS 侧载 .ipa（未签名，无需开发者账号）
npm run mobile:build:android
```

## 项目结构

```
├── src/
│   ├── views/           # 页面视图
│   ├── components/      # 组件
│   │   ├── icons/       # SVG 图标组件
│   │   ├── calendar/    # 日历视图子组件
│   │   ├── matrix/      # 四象限子组件
│   │   └── layouts/     # 布局组件
│   ├── stores/          # Pinia 状态管理
│   ├── services/        # 服务层 (SQLite / 数据访问 / 同步)
│   └── router/          # 路由配置
├── electron/            # Electron 主进程
├── dist/                # 编译输出
├── docs/                # 文档
│   ├── INSTALL.md       # 安装指南
│   └── adr-*.md         # 架构决策记录
└── release/             # 发布说明
```

## 构建命令

| 命令 | 输出 | 说明 |
|------|------|------|
| `npm run dev` | — | 开发服务器 (localhost:3000) |
| `npm run build` | `dist/` | 编译前端资源 |
| `npm run dist` | `.dmg` | macOS 安装包 |
| `npm run electron:build` | `dist-electron/` | macOS 构建目录 |
| `npm run mobile:sync` | `ios/` `android/` | 同步前端到原生项目 |
| `npm run mobile:build:ios` | `.ipa` | iOS 侧载安装包 (未签名, 需 Xcode) |
| `npm run mobile:build:android` | `.apk` | Android 安装包 |
| `npm run release:all` | 全部 | 一键全平台构建 |

## 许可证

[MIT](LICENSE)

