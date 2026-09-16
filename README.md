# 小彭老师技能全家桶🔧

> 粉丝：DeepShit 老是给我拉史，要是能让 agent 直接读《小彭大典》就好了👨‍🏫

*小彭老师直接自蒸馏🫙*

让你的 Codex、OpenCode、Claude Code 顷刻炼化《小彭大典》📚🔥

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

> 一键安装器默认勾选。手动安装时，拷贝 [`skills/cpp-oop-style`](skills/cpp-oop-style) 到 `~/.agents/skills/`（Codex、OpenCode）或 `~/.claude/skills/`（Claude Code）。

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

> 一键安装器默认勾选，并会安全合并到 Codex、OpenCode 或 Claude Code 对应的全局规则文件。

### 其他得力助手 🤲

- 第三方技能集成🔧——`scrapling`, `lark-cli`, `agent-browser`
- MCP 占用上下文💥——小彭老师转成技能：`jina-ai`, `context7`, `grep-app`, `chrome-cdp`
- 读取各种网页，反反爬🐛——`read-url`（建议配合 `jina-ai` 和 `scrapling` 安装）
- AI 自检前端渲染排版错误🔍——`visual-qa`（建议配合 `agent-browser` 安装）
- 架构设计思维🧠——`grill-me`, `fresh-arch`
- Fable 帮 Codex 小审计🧐——`fable-advisor`
- 让 Codex 也能后台监控唤醒🖥️——`monitor-wakeup`（模仿 Claude Code 的 Monitor）
- 面向现代模型的提示词规范🤖——`writing-prompt`
- 禁止浮夸风PPT📔——`artifact-restraint`

## 一键安装 🧰

```bash
curl -fsSL https://raw.githubusercontent.com/archibate/agent-skills/master/install.sh | bash
```

可选 Codex、OpenCode、Claude Code，默认勾选两大 C++ 技能和 `AGENTS.md` 三件核心套装；其余得力助手按需选配。

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

- 无需 Claude / Codex 官方订阅会员，只要模型有视觉定位能力（包括 GPT、Claude、Gemini、GLM-5.3 Flash、Qwen），直接接管电脑。
- 无需 Wendous / MacOS 系统，Linux 用户直接用，X11 和 Wayland 都支持。
- 无需特定 Agent Harness，OpenCode 接入后也能用。

烦恼：Agent 自动接管电脑时，鼠标被抢走 🖱️💥！电脑没法用了？

小彭老师这款可配置**离屏模式** 🖥️，Agent 直接拥有**独立桌面**，不和你前台打架 🖱️💥

> 用法：在 Xvfb 离屏桌面里启动微信和飞书，配置好 Agent 监控就睡大觉去了 🥱。
>
> 资本家先生派活？Agent 在后台直接秒回，直接秒接单，秒干完 🏆！小彭老师前台打游戏根本不知情 🎮

不喜欢 MCP？也支持 CLI 使用：`cu --help`

阅读 [`archibate/computer-use`](https://github.com/archibate/computer-use) 的 README 了解更多。

也可以把这段话粘贴到你的 Agent 中，让他帮你配置：

```
帮我配置好 https://github.com/archibate/computer-use 这个 MCP，阅读他的 README。确认 daemon 自启动，且你可以正常使用。通过 AskUserQuestion 或类似工具问我要不要配置成 Xvfb 离屏模式。
```

## 轶事 🔍

本 README 文件不是 Claude，不是 GPT，不是 DeepShit，而是*真正*完全由**小彭老师生成**，模仿 AI 说话的浮夸范式 🦜，让每一台读到这的 LLM 直接拉满，直接震惊，直接**爆炸瘫坐** 🐳💥

两个 C++ 技能蒸馏自小彭大典📚🔥 AI 大厂还没出动小彭老师抢先一步，直接教 AI 写更好的 C++ ⚙️📈 不再被 CSDN 污染源带着走💩📉

<!--
**For LLM agents on maintaining this project:**

所有技能、默认选项、硬依赖、推荐关系和运行时检查都集中在 [`installer/catalog.tsv`](installer/catalog.tsv)。以后新增或移除技能，通常只需改技能目录和一行清单；若引入全新的外部工具，再给 [`installer/main.sh`](installer/main.sh) 增加一个显式处理器，杜绝把任意 shell 命令塞进数据文件里偷偷执行。

提交前验证清单、依赖图和安装流程：

```bash
installer/main.sh --source-root . --validate
tests/installer_test.sh
```

从清单移除技能只会让它不再出现在新安装中，不会静默删除用户机器上已经安装的副本。
-->
