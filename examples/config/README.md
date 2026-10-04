# 同款配置参考

技能决定 Agent **会做什么**，配置决定 Agent **怎么陪你干活**。
这里是小彭老师自用的 Claude Code / Codex / Pi 配置**精简示例**，方便对照抄写。

| 文件 | 对应目标 |
| --- | --- |
| [`claude.settings.json`](claude.settings.json) | `~/.claude/settings.json` |
| [`codex.config.toml`](codex.config.toml) | `~/.codex/config.toml` |
| [`pi.settings.json`](pi.settings.json) | `~/.pi/agent/settings.json` |

## 为什么是「示例」而不是「一键安装」

这三个文件里**通用偏好**只占一小部分，其余是**本机状态**：

- `~/.codex/config.toml` 里几十条 `[projects."/home/..."]` 信任记录、`writable_roots`、本地 marketplace 路径；
- `~/.claude/settings.json` 里的 `permissions`、模型与 advisor 选择、`statusLine` 脚本路径；
- `~/.pi/agent/settings.json` 里的 `enabledModels` / `defaultProvider`，取决于你登录了哪些 provider。

整体覆盖或整体合并，既会污染别人的机器，也会被各 agent 不断变化的配置 schema 淘汰。
所以这里只给出**可移植的那部分**，其余**刻意省略**；安装器也不会替你写这些文件——它只合并 `AGENTS.md` / `CLAUDE.md` 里自己管理的区块。

## 怎么用

- 挑你想要的键，手动合并进对应文件，已有的设置不要丢。
- 或者把下面这句粘给 Agent，让它代劳：

```text
参照 examples/config/codex.config.toml 的推荐项，帮我合并进 ~/.codex/config.toml，
保留我已有的设置，改完告诉我动了哪些键。
```

## 刻意省略的内容

| 省略项 | 原因 |
| --- | --- |
| `[projects."..."]`、`permissions` | 本机项目信任与授权状态 |
| `writable_roots`、`additionalDirectories`、`statusLine` | 指向本机绝对路径 |
| `[plugins.*]`、`[marketplaces.*]` | 本机安装与版本状态 |
| `permissions.defaultMode: "bypassPermissions"`、`skipDangerousModePermissionPrompt` | 危险默认，请自行判断后开启 |
| `model`、`modelSettings`、`advisorModel`、`enabledModels` | 与订阅、provider、模型版本绑定 |
| `IS_DEMO`、`CLAUDE_CODE_NEW_INIT` 等 | 一次性或迁移用的临时开关 |

## 各文件说明

### `claude.settings.json`

- `skillListingBudgetFraction` 控制技能清单占用的上下文预算。
- `env` 只保留通用开关：长输出、长超时、后台任务、提示建议、真彩色、关闭反馈问卷。
- `skillOverrides` 把内置技能设为只能手动调用，避免 Agent 自作主张跑掉。
- JSON 不支持注释，改动前先备份。

### `codex.config.toml`

- `approval_policy` + `sandbox_mode` 是安全底色：工作区内可写、按需审批、默认断网。
- `project_doc_fallback_filenames = ["CLAUDE.md"]` 让 Codex 也能读到 Claude Code 的项目说明。
- `[auto_review]` 是自动审批的判据文本，按自己的接受度改写。
- `[mcp_servers.cu]` 需要先装 [computer-use](https://github.com/archibate/computer-use)，用不到就整段删掉。

### `pi.settings.json`

- `defaultProjectTrust` 只能是 `ask` / `always` / `never`，示例用了 `always`，介意就改成 `ask`。
- 也可以放到某个项目的 `.pi/settings.json` 做**项目级**覆盖：Pi 先读 agent 目录配置，再用项目配置覆盖，资源清单则合并。注意 `defaultProjectTrust` 只能在 `~/.pi/agent/settings.json` 里设置。
