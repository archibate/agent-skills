# 小彭老师技能全家桶🔧

> 粉丝：DeepShit 老是给我拉史，要是能让 agent 直接读《小彭大典》就好了👨‍🏫

*小彭老师直接自蒸馏🫙*

让你的 Codex、OpenCode、Claude Code、Pi 顷刻炼化《小彭大典》📚🔥

```bash
curl -fsSL https://raw.githubusercontent.com/archibate/agent-skills/master/install.sh | bash
```

`raw.githubusercontent.com` 抽风时，走 Git 安装：

```bash
git clone --depth 1 https://github.com/archibate/agent-skills.git && cd agent-skills && ./install.sh
```

## 核心出装

### `cpp-oop-style` ✍️

蒸馏自《小彭大典》 + 小彭老师公开课——凝聚小彭老师呕心沥血布道的 **C++ 最佳实践**，让您的 agent 写出**小彭老师同款**的高可维护性现代 C++！

《小彭大典》定义了一系列经传奇程序员小彭老师**海量工程实践**验证的高质量代码规范。

直接覆盖 AI 默认的泔水风，不再拉一次性流水账代码。**长期项目**更安心🔐

涵盖海量设计模式，代码风格，虚函数最佳实践，API/SPI 接口层，静态/动态多态，值语义/指针语义，函数式编程，节制 auto，类型安全，RAII 封装，C++ 实用特性，错误/异常处理，类型转换，未定义行为，Unicode 编码，第三方库推荐等诸多方面，写出长期可维护的代码。

直接罗列了 C++ **常见错误范式**🚨！阻止 AI 无意中写出低质量代码。

甚至还覆盖了小彭老师引以为傲的**现代 CMake**，从第三方库引入，到源码与头文件模块化组织方案，ABI 兼容性，依赖项治理，C++ 软件部署与分发最佳实践！🛠️

> 会根据项目指定的 C++ 标准调整写法，并在需要时给出 C++17/20/23 的对应方案。

本技能不仅可以用于写出高质量代码，也能审查现有代码，随时调用一位虚拟小彭老师监督你。

> 一键安装器默认勾选。手动安装时，拷贝 [`skills/cpp-oop-style`](skills/cpp-oop-style) 到 `~/.agents/skills/`（Codex、OpenCode、Pi）或 `~/.claude/skills/`（Claude Code）。

### `cpp-hpc-optimization` 🚤

蒸馏自小彭老师《高性能并行编程与优化》公开课 & SIMD 加速教程——榨干小彭老师毕生所学：

性能分析，高性能优化技巧，涵盖多核并行，冷热分离，编译器优化利用，SIMD 矢量化技巧，高维数组扁平化，稀疏矩阵，缓存友好型数据结构，内存碎片管理与 PMR，面向数据编程范式，还覆盖一点 CUDA。

每个都带**案例代码**演示，agent 可直接模式匹配。

基于**实证主义**的性能优化，让**数据**说话：

- 性能：优化前后分别做性能测试，找到瓶颈部位下手，**不盲目优化**，完成后确保性能提升，变成数据你看得见。
- 正确性：完善单元测试，覆盖边缘情况，确保优化前后**代码功能不变**，误差在浮点精度内。

> 一键安装器默认勾选，并会自动带上 `cpp-oop-style` 依赖。

### `AGENTS.md` 🤵‍♂️

编程 agent 最严厉父亲——小彭老师化身为提示词，狠狠鞭策！🤺

超 25 条**自律规则**——开工前必须先探索上下文，小规模烟测，小众第三方库用前必查证消幻觉，不要偷懒最小化修改量，严禁猴子补丁，简单能自己验证的问题不许停下等用户决策，修复必须修复真正根源，宣布完工前自己清理遗留垃圾等。

> 一键安装器默认勾选，并会安全合并到 Codex、OpenCode、Claude Code 或 Pi 对应的全局规则文件。

### 其他得力助手 🤲

- 第三方技能集成🔧——`lark-cli`, `agent-browser`
- MCP 占用上下文💥——小彭老师转成技能：`web-search`, `context7`, `grep-app`, `chrome-cdp`
- 读取各种网页，反反爬🐛——`web-fetch`（建议配合 `web-search` 安装）
- AI 自检前端渲染排版错误🔍——`visual-qa`（建议配合 `agent-browser` 安装）
- 架构设计不史山🧠——`grill-me`, `fresh-arch`
- 系统软件安全审计🛡️——`system-software-audit`
- 后台测试时不得干扰用户🔇——`e2e-side-effect-safety`
- 让 Codex 也能后台监控唤醒🖥️——`monitor-wakeup`（模仿 Claude Code 的 Monitor）
- 让 Pi 也并行多智能体🤖——`pi-subagents`（模仿 Claude Code 的 ultracode）
- 面向现代模型的提示词规范✍️——`writing-prompt`
- 禁止浮夸风PPT📔——`artifact-restraint`

## 一键安装 🧰

```bash
curl -fsSL https://raw.githubusercontent.com/archibate/agent-skills/master/install.sh | bash
```

可选 Codex、OpenCode、Claude Code、Pi，默认勾选两大 C++ 技能和 `AGENTS.md` 三件核心套装；其余得力助手按需选配。

安装器会自动补齐技能依赖，检查 CLI、浏览器、API Key 等运行条件，并在执行任何用户级依赖安装前亮出完整命令。不碰 `sudo`，不偷存密钥。已有技能和全局规则会先备份，`AGENTS.md` 只更新安装器管理的区块，不会一把扬了你的私人配置。

从完整 Git 仓库运行时，安装器默认把所选技能链接到当前仓库；以后在仓库中 `git pull`，各 agent 立即吃到更新。请勿移动或删除这个仓库。若想安装独立副本，可传 `--install-mode copy`。`curl | bash` 下载的临时源码则始终默认复制，脚本退出后不会留下断链。

非交互式安装：

```bash
curl -fsSL https://raw.githubusercontent.com/archibate/agent-skills/master/install.sh |
  bash -s -- --profile core --targets codex,opencode --yes
```

## 选配桌面 MCP 🔌

想让 Agent 自己操作 GUI，自动化键盘鼠标？

看看小彭老师 [`archibate/computer-use`](https://github.com/archibate/computer-use) MCP。

- 无需 Claude / Codex 官方订阅会员，只要模型有视觉定位能力（包括 GPT、Claude、Gemini、DeepSeek V4.1、GLM-5.3 Flash、Qwen），直接接管电脑。
- 无需 Wendous / MacOS 系统，Linux 用户直接用，X11 和 Wayland 都支持。
- 无需特定 Agent Harness，OpenCode 接入后也能用。

烦恼：Agent 自动接管电脑时，鼠标被抢走 🖱️💥！电脑没法用了？

小彭老师这款支持 Xvfb **离屏模式** 🖥️，Agent 直接拥有**独立桌面**，不和你前台打架 🖱️💥

> 用法：在离屏桌面里启动微信或飞书，配置好 Agent 监控就睡大觉去了 🥱。
>
> 资本家先生派活？Agent 在后台直接秒回，直接秒接单，秒干完 🏆！小彭老师前台打游戏根本不知情 🎮

不喜欢 MCP？也支持 CLI 使用：`cu --help`

阅读 [`archibate/computer-use`](https://github.com/archibate/computer-use) 的 README 了解更多。

也可以把这段话粘贴到你的 Agent 中，让他帮你配置：

```
帮我配置好 https://github.com/archibate/computer-use 这个 MCP，阅读他的 README。确认 daemon 自启动，且你可以正常使用。
```

## 同款配置参考 🎛️

不仅照抄技能，小彭老师的配置文件也想炒？请看 [`examples/config/`](examples/config/)：

- Claude Code: [`claude.settings.json`](examples/config/claude.settings.json)
- Codex: [`codex.config.toml`](examples/config/codex.config.toml)
- Pi: [`pi.settings.json`](examples/config/pi.settings.json)

只保留了和个人机器无关的通用偏好：审批与沙箱策略、推理档位、状态栏、快捷键、工具开关等。不包含小彭老师 API key 哦 😂

考虑到每个人环境不同，“一键安装器”不会自动装这些配置文件 🚯 想完全照抄，可以把这句话粘贴进 Agent：

```text
参照 examples/config/codex.config.toml 的推荐项，帮我合并进 ~/.codex/config.toml，保留我已有的设置。
```

## Pi 扩展包 🧩

小彭老师嫌 Pi 不好用，直接用 Pi 的可扩展性手搓成 Claude Code 同款 harness，“一键安装器”里一勾选，直接起飞 🛫 隔壁 Codex 只有眼馋的份 😤

- `jobs` 🖥️——让 Pi 也能开**后台长任务**：`job_start` 后台启动不卡 agent loop、`job_watch` 订阅日志更新时收到通知、作业退出自动叫醒 agent；Pi 原生轻量化 `bash` 不变，只是偷偷补了默认超时，提醒可以用 `jobs`，agent 忘写 timeout 也不会一卡一整天。用户侧敲 `/jobs` 看当前后台在跑什么。任务的输出日志、退出码全部落在 `$XDG_RUNTIME_DIR/pi-jobs/<id>/`，agent 自己 `tail` 随时可查。
- `sandbox` 🛡️——启用 `--enable-sandbox` 后让 agent 的 `bash` 和 `job_start` 按声明的权限运行在 **bubblewrap + Landlock 沙箱**里：默认只读、无网络，需要写目录、联网或访问桌面时显式声明；超出会话预授权的调用弹窗审批，后台运行直接拒绝 😤 `/permissions` 随时调整预授权，也可从命令行指定 `--permissions read-only`。详见 [运行要求与限制](extensions-pi/sandbox/README.md#requirements)。
- `scratchpad` 🗒️——每个 Pi 会话独享一块**草稿工作空间** `~/.cache/pi/scratchpad/<session_id>`，脚本、中间结果、临时文件统统往里扔，不污染你的项目树，也不跟 `/tmp` 里其他 agent 竞争。
- `context` 📊——`/context` 把**上下文窗口**像 Claude Code 一样拆开给你看：系统提示、项目规则、技能、工具、MCP、消息、摘要各占多少，还剩多少自由空间。`/context all` 连每个工具每个技能消耗了多少都算清，再也不用盲猜是谁在爆我 token 💸💥
- `prompt-stash` 📝——Claude Code 同款 **Ctrl+S 暂存草稿**：想法写一半突然被新点子岔开，先按一下存起来，以后再按一下就能取回，万一两坨草稿都满了还能互换，绝对不丢。
- `fresh` 🌱——`/fresh` 选择重新思考的起点（默认首条用户消息），在当前会话回到该消息之前，把从此处开始的**用户消息**合成一条草稿放进输入框，不自动发送；旧分支保留在 `/tree`，文件不回滚。
- `advisor` 🧠——主模型先收集证据，再调用**无工具顾问**审查方案或结果；`/advisor` 搜索选择，`Ctrl+S` 保存与主模型的配对；也支持 `--advisor` 覆盖，默认关闭。保留对话、工具结果和图片，不转发私有思考，显示用量与缓存读取。
- `btw` 🤫——执行到一半，有小疑惑但不想污染主对话？`/btw` 开个**旁路小提问**：复用主分支的 prompt 缓存，主会话不被写回，agent 一边流式输出时你都能追问！`/btw` 子 agent 只读，能调查，不能修改文件。
- `plan-mode` 🗺️——`/plan` 或 `Ctrl+Alt+P` 切**只读计划模式**，每轮都敲脑袋提醒模型“你目前只读”，给你出计划，你再按一次 `/plan` 关闭计划模式后，才提醒“放行” 🚓
- `rewind` ⏪——Claude Code 同款**代码快照**：Pi 的每次 `edit` 和 `write` 都会被快照记录，`/rewind`（`Ctrl+Alt+R`）列出本会话每个用户提问的时间点，选中即可代码和对话一起回滚，也可以单独只回滚对话或代码；Pi 原生的 `/tree`（`Esc Esc`）保持不动。
- `rmb-cost` 💴——状态栏、`/session`、缓存/压缩提示和 codemode 的美元成本**就地换算成 ¥**，因为中国人能飞。
- `subagent-cost` 🧮——把 `job_start` 启动的 Pi 子 agent 成本**算进主会话状态栏**，`/session` 分列主、子和合计；子端自行登记、文件事件驱动更新，闲时不轮询，fork 不重复计费，配合 `rmb-cost` 显示人民币。
- `ofox` 🦊——从 [Ofox](https://ofox.io) **自动发现模型**，`/ofox-refresh` 更新列表，不用手写 `models.json` 重定向。
- `pi-subagents` 🦾——建议配合 `jobs` 和 `sandbox` 安装，真正符合**万物皆 bash** 的 Pi 哲学，把 subagent 也作为 bash 后台任务管理，主 agent 自己掌握节奏；可从脚本批量启动，可自由组合，开启您的大并行时代 🦾🦾🦾👋🤖

> 安装器里勾选 Pi 为目标 agent 后，这些扩展按需勾选安装。

## 轶事 🔍

本 README 文件不是 Claude，不是 GPT，不是 DeepShit，而是*真正*完全由**小彭老师生成**，模仿 AI 说话的浮夸范式 🦜，让每一台读到这的 LLM 直接拉满，直接震惊，直接**爆炸瘫坐** 🐳💥

两个 C++ 技能蒸馏自小彭大典📚🔥 AI 大厂还没出动小彭老师抢先一步，直接教 AI 写更好的 C++ ⚙️📈 不再被 CSDN 污染源带着走💩📉

<!--
**For LLM agents on maintaining this project:**

所有技能、默认选项、硬依赖、推荐关系和运行时检查都集中在 [`installer/catalog.tsv`](installer/catalog.tsv)。以后新增或移除技能，通常只需改技能目录和一行清单；若引入全新的外部工具，再给 [`installer/main.sh`](installer/main.sh) 增加一个显式处理器，杜绝把任意 shell 命令塞进数据文件里偷偷执行。

目标受限技能（`targets` 列不是 `-` 且未覆盖 codex/opencode/pi 全部）的源码必须放在 `skills-<target>/` 下，不能放 `skills/`：`~/.agents/skills` 是各 agent 共享扫描目录，放进去会泄漏给所有 agent，安装器会把它装进对应 agent 的私有技能目录（如 `~/.codex/skills`）。

提交前验证清单、依赖图和安装流程：

```bash
installer/main.sh --source-root . --validate
tests/installer_test.sh
```

从清单移除技能只会让它不再出现在新安装中，不会静默删除用户机器上已经安装的副本。
-->
