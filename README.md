# T3 Code 增强版

[![Fork macOS and Android release](https://github.com/uiliugang/t3code/actions/workflows/fork-release.yml/badge.svg)](https://github.com/uiliugang/t3code/actions/workflows/fork-release.yml)

基于 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的个人增强分支，面向中文使用、多仓库协同开发和美团内部研发流程。在上游 Web、Electron 桌面端和 React Native 移动端架构之上，扩展需求管理、代码平台集成、Skills 管理和模型配置。

代理运行在你自己的电脑或远程服务器上，客户端通过同一个环境管理项目、对话、终端、代码变更和任务。使用已有的代理订阅或自行配置的 API 服务；本项目不提供模型服务。

本分支仓库：[uiliugang/t3code](https://github.com/uiliugang/t3code)。下列增强以当前仓库已合入的提交为准，各端支持范围以对应使用指南为准。

## 项目功能

- **多代理开发**：接入 Codex、Claude Code、Cursor、Grok Build、OpenCode、Antigravity 等代理，在对话中完成开发、执行命令和审查代码。
- **项目与任务管理**：按项目组织对话，使用独立 Git Worktree 隔离任务，查看每轮变更、检查点并恢复文件。
- **代码协作**：查看差异、提交和推送代码，创建、评审、关联及跟踪 PR。
- **远程访问**：从浏览器、桌面或手机连接运行代理的环境，支持局域网、Tailscale 和 T3 Connect。
- **自动化与代理工具**：通过 MCP 操作项目和任务，使用定时任务和 Webhook 驱动工作流。

以上能力继承自 T3 Code。下面列出本分支增加或强化的部分。

## 相比原版 T3 Code 的增强

| 方向            | 本分支增加或强化的能力                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中文与外观      | 支持简体中文界面，补齐设置和常用操作翻译；让代理生成的提交及 PR 文案遵循界面语言；增加主题、Claude Desktop 主题下的 GoLand 代码配色及差异颜色设置。                       |
| 多仓库工作区    | 将前端、后端等仓库组成一个工作区，为各仓库创建独立 Worktree，选择主仓库，配置仓库上下文及脚本范围，按仓库查看变更、提交、终端和编辑器入口。                               |
| 项目导入        | 批量选择本地文件夹导入项目，识别已有项目和重复仓库；支持单仓库分组，优化分组标识和项目展示。                                                                              |
| 需求管理        | 统一浏览 MEP ONES 和 GitHub Issues，支持看板与列表、项目和负责人筛选、新建、详情及状态变更；自动识别 GitHub 仓库，并从近期美团 PR 及关联分支发现 MEP 空间，也可手动覆盖。 |
| 分支关联需求    | 为已推送分支关联 GitHub Issue 或 MEP 工作项；按工作区仓库和分支聚合展示关联需求。GitHub 关联保存在 T3 环境中，美团关联写入 MEP；每个分支当前关联一个需求。                |
| 美团研发集成    | 接入美团代码平台，支持仓库、PR 和评审流程；支持 MOA 免登或大象授权，在 PR 中向选定评审人发送大象链接。                                                                    |
| Skills 管理     | 统一管理共享安装包和各代理使用位置，收纳已有技能、筛选已托管技能、管理目录链接；支持每日更新检查、更新策略、版本恢复，以及目录冲突备份和原位置恢复。                      |
| 模型配置        | 增加 Claude BYOK 实例，配置第三方 API 地址、认证和模型 ID，检查连接及模型工具调用；支持编辑内置模型、自定义模型 ID 和同步 API 模型目录。                                  |
| Git 与 Worktree | 默认限制新 Worktree 基于 main/master，保护主分支；合并后安全快进本地主分支，可选清理已合并分支和 Worktree；支持按组手动清理和重建。                                       |
| 配置迁移        | 导入、导出客户端偏好、主题、快捷键、模型配置及项目设置；可在另一环境克隆仓库并恢复项目或工作区分组，查看进度和重试失败导入。                                              |
| 日常体验        | 可选预测下一条用户消息；优化 Markdown 默认预览、Diff 文件类型筛选、变更预览和用量展示。                                                                                   |
| 连接与发行      | 改善 SSH 环境运行时下载失败时的中转回退；增加本分支 macOS Apple Silicon DMG 和 Android APK 构建发布流程。                                                                 |

## 安装与启动

### 使用本分支构建包

查看 [本分支 Releases](https://github.com/uiliugang/t3code/releases) 中实际可用的附件。仓库提供 macOS Apple Silicon（arm64）DMG 和独立 Android APK 的构建流程；尚未发布的版本可从源码启动。

- macOS 包采用 ad hoc 签名，未经过 Apple 公证，首次打开可能需要在系统安全设置中明确允许。
- Android 使用独立包名 `com.uiliugang.t3code`。
- 本分支构建关闭桌面自动更新和上游 Android OTA 更新，请从本仓库获取后续版本。

上游的 `npx t3@latest`、官网安装脚本、应用商店和包管理器安装入口分发的是上游版本，不保证包含这里列出的增强。

#### macOS 提示无法验证应用

没有 Apple 开发者账号时，本分支无法通过 Developer ID 签名和 Apple 公证消除首次打开的拦截。确认安装包来自可信来源后，将应用拖入「应用程序」文件夹，尝试打开一次，再前往「系统设置 → 隐私与安全性」选择「仍要打开」，按提示确认。

也可以在终端中移除该应用的下载隔离标记，然后重新打开：

```bash
xattr -dr com.apple.quarantine "/Applications/T3 Code (Beta).app"
open "/Applications/T3 Code (Beta).app"
```

如果应用安装在其他位置，请将两处路径替换为实际路径。此操作只移除指定应用的隔离标记，不代表应用通过了 Apple 验证，也不会关闭系统的 Gatekeeper。重新下载或更新后可能需要再次处理。

### 从源码运行本分支

需要 Git、仓库指定的 Node.js 版本（当前为 `26.12.1`）和 [Vite+](https://viteplus.dev/guide/) 的 `vp` 命令。

```bash
git clone https://github.com/uiliugang/t3code.git
cd t3code
vp i
vp run dev
```

使用终端输出的地址访问 Web 客户端，不要假定固定端口。开发环境使用隔离的数据目录，首次启动可能复制本机已有 T3 数据的裁剪副本，详见 [开发指南](./docs/operations/development.md)。

启动桌面开发模式：

```bash
vp run dev:desktop
```

开发模式通过同源代理访问服务端，无需设置 `VITE_HTTP_URL` 或 `VITE_WS_URL`。

### 准备代理

在**运行 T3 服务端的机器**上安装并认证至少一种代理，例如 Claude Code。其他代理的安装入口见 [安装与首次运行](./docs/user/install.md)。Antigravity 可在设置中安装并使用 Google 登录。

订阅账号和第三方 API 是不同的配置方式。使用自有 API 时，请按下方 Claude BYOK 流程配置。

## 使用方式

### 开始一次开发任务

1. 在设置中选择界面语言、代理和默认模型。中文入口为 **Settings → Appearance → Language → 简体中文**；部分未翻译文本仍显示英文。
2. 添加项目，或通过 **Settings → Projects → Import folders** 批量导入本地仓库。
3. 新建任务，选择当前检出目录或新的 Worktree，再选择代理和模型并发送需求。
4. 在变更面板检查代码，完成提交、推送和 PR。需要异地继续时，从另一客户端连接同一环境。

### 让代理同时修改多个仓库

从侧栏或命令面板选择 **Create group**，选择环境、仓库和主仓库。一个组支持 1–16 个仓库；可在 **Settings → Projects → Repositories** 配置别名、上下文和路径。

目前多仓库任务支持 **Codex 和 Claude**。新任务选择 Worktree 后，各仓库分别准备检出目录和初始化脚本，全部准备完成才启动代理。项目动作的 **Run in repositories** 决定脚本在哪些仓库运行。现有任务保留创建时的仓库绑定。

在任务详情中选择对应仓库查看 Diff、提交或打开终端。需要释放空间时，在 **Settings → Worktrees → Local worktrees** 选择单个 Worktree 或整组清理；分支、提交和对话历史保留，可重建目录，但被删除的忽略文件（如 `.env`）不能恢复。

详见 [项目、仓库组与 Worktree 设置](./docs/user/project-settings.md)。

### 管理需求并关联开发分支

打开 **Requirements board**，选择环境及 MEP 或 GitHub 数据源，按项目、负责人搜索工作项，切换看板或列表，查看详情、新建需求或修改状态。

**Settings → Code → Issue management** 展示自动识别的仓库和 MEP 空间，可重新检测或手动覆盖；多个 MEP 空间 ID 使用逗号分隔。MEP 依赖服务端已安装并登录的 `ones2`，GitHub 使用源码管理中的认证。

推送开发分支后，在仓库详情的 **Linked issues** 添加需求链接；换绑前先解除当前关联。解除关联不会删除需求，GitHub 关联也不会在 PR 合并时自动关闭 Issue。

### 接入美团代码平台与大象

在能访问美团网络的服务端安装 `code-cli` 0.1.27 或更新版本：

```bash
npm install -g @ee/code-cli@latest --registry=http://r.npm.sankuai.com
code-cli auth login
code-cli auth status
```

MOA 免登可用时会自动使用；也可在 **Settings → Source control → Meituan Code** 保存 MIS，通过大象完成授权。大象授权需要服务端具备相应 CIBA 配置；其他环境使用 CLI 登录。

发送评审链接前，在 **Settings → Connections → Communication** 配置大象应用 Client ID 和 Client Secret。应用需具备员工查询及机器人发消息权限；随后在 PR 摘要中选择评审人并执行 **Send PR link**。

本构建启用 GitHub 和美团代码平台，其他上游托管平台集成当前关闭。完整说明见 [源码管理](./docs/user/source-control.md)。

### 统一管理 Skills

打开 **Settings → Skills**，安装技能或将已有技能纳入管理，再选择共享目录及代理使用位置。托管技能通过目录链接分发，位置冲突时先备份原内容再替换。

为每个技能选择自动更新、手动更新或不更新；有本地修改时，自动应用会被阻止，需先确认处理方式。可以恢复早期版本、停止托管并保留文件、恢复原位置或卸载。Web、桌面和移动端共享所连接环境的管理结果。

详见 [Skills 管理与更新](./docs/user/skills.md)。

### 使用 Claude BYOK 和自定义模型

在 **Settings → Providers** 添加 **Claude → Claude · BYOK**，填写服务商的 Anthropic base URL，选择 Bearer Token 或 API Key，添加准确且区分大小写的模型 ID。

服务必须兼容 **Anthropic Messages API**；仅支持 OpenAI Chat Completions 的地址不能直接使用。服务端仍需安装 Claude Code，或指定其可执行文件。

保存后先执行 **Check connection**；需要验证实际推理和工具调用时再执行 **Test model & tools**，后者会发送请求并产生 API 用量。密钥保存在所选环境，远程场景中的 `localhost` 指服务端机器。

详见 [Claude 账号、自定义 API 与 BYOK](./docs/user/providers-claude.md)。

### 迁移配置与开启预测消息

- Web / 桌面：在 **Settings → General → Import and export** 导出或导入配置；移动端入口为 **Settings → About → Client Storage**。需要在新机器恢复项目时，选择克隆仓库和创建项目或工作区组。导出不包含账号凭据和对话历史，但动作命令及自定义指令按原样导出，分享前请检查。
- 在 **Settings → Chat → Show predicted messages** 开启下一条消息预测。建议可先放入草稿编辑，再由你发送；默认关闭，会消耗文本生成模型的用量。

## 文档与开发

- [文档索引](./docs/README.md)
- [安装与首次运行](./docs/user/install.md)
- [远程访问](./docs/user/remote-access.md) · [后台服务](./docs/user/background-service.md)
- [权限模式](./docs/user/permission-modes.md) · [外部代理与 MCP](./docs/user/outside-agents.md)
- [主题与语言](./docs/user/appearance.md) · [快捷键](./docs/user/keybindings.md)
- [项目设置、配置迁移与清理](./docs/user/project-settings.md)
- [架构概览](./docs/internals/overview.md) · [开发指南](./docs/operations/development.md)

修改代码前请阅读 [AGENTS.md](./AGENTS.md) 和 [CONTRIBUTING.md](./CONTRIBUTING.md)。提交前运行 `vp run check:changed`，检查本次变更涉及的文件。

本项目沿用上游 [LICENSE](./LICENSE)，感谢 T3 Code 及其贡献者。上游文档中的发行入口、平台支持和默认行为可能与本分支不同，请结合本文及当前实现使用。
