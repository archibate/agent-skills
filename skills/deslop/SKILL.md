---
name: deslop
description: >
  Review an AI-generated article to detect AI slop patterns. Loads a AI slop pattern checklist. Rewrite to strip AI smell without changing meaning or losing information. Restores a human voice. Use before publishing any AI-written article to public under the name of human author.
---

# Deslop — Strip AI Slop Smell From an Article

Rewrite an AI-generated article into prose that a human author would actually publish: same information, restored voice, no decorative scaffolding.

## Overview

LLMs default to a recognizable "slop register": emoji-stuffed headers, marketing buzzwords, forced trichotomies, tables for everything, sanitized opinions, and template sections that repeat across the whole document. Readers detect this within seconds and discount the content. This skill applies a fixed checklist to identify those patterns, then rewrites them while preserving the underlying facts and structure the author actually needs.

### Two layers of slop

Slop is not one thing. It comes in two layers, and they are removed by different means:

1. **Surface slop** — emoji, marketing hyperbole ("革命/降维打击/封神"), philosophy tics ("归根结底/本质是/说白了"), Chinese-English code-mixing. Models *recognize* these as slop. A simple "rewrite in a human voice" prompt removes them reliably across all voice variants.
2. **Structural slop** — markdown headers, numbered sections (一/二/三 or 1/2/3), two-column tables for trivial pairs, 总-分-总 closures, "三大优势/四大要点" forced groupings, tacked-on "总结" paragraphs. Models do NOT recognize these as slop — they treat them as "good organization" or "professional formatting". Voice prompts leave structural slop intact, and may even *reinforce* it: when asked to rewrite a sloppy article in a human voice without further constraints, the model typically expands rather than condenses, adding more sections and headers along the way.

This split is why the skill cannot collapse into a single voice instruction. Removing surface slop is the easy half — any tone prompt does it. Removing structural slop requires explicit constraint: drop headers, drop numbered groupings, default to prose, justify every table, refuse to add a closing summary the original didn't have. The 4-phase workflow and the checklist below operationalize that. When in a hurry and the workflow is too heavy, the minimum viable prompt is "rewrite in a human voice + no markdown headers, no numbered sections, no tables, no closing summary, ≤N words" — but that is the floor, not the ceiling, of what this skill should produce.

## When to Use

- User pastes or points to an AI-generated article and wants it cleaned
- User wrote a draft with AI assistance and now wants a human-voice pass
- User asks to "deslop", "remove AI slop", "make this sound human", "depollute"
- Polishing AI-translated marketing copy, blog posts, video descriptions, READMEs

## When NOT to Use

- Generating new content from scratch (use the appropriate writing skill)
- Translating between languages (do loseless English→Chinese translation first)
- Polishing prose that is already in human voice — just edit directly

## Workflow

### Phase 1: Read the Original

Read the entire article end-to-end before editing anything. Identify:

- **Domain & audience** — technical post, marketing copy, tutorial, video description?
- **Author voice clues** — first-person anecdotes, idioms, jokes, complaints? If the source has none, ask the user for a reference sample of their actual voice. Without that, the rewrite can only reach "neutral", not "their voice".
- **Real information** — concrete numbers, names, prices, specs, opinions, citations. These survive the rewrite untouched.
- **Slop scaffolding** — what was added purely as decoration. This is what gets stripped.

If the user supplied a "before" (slop) and "after" (human) pair as reference, study the diff first — the user's actual voice in the "after" trumps any generic guidance below.

### Phase 2: Apply the Slop Checklist

Walk the article and tag every instance against the checklist below. Do not rewrite yet — produce the inventory first so you can show it to the user if asked.

#### A. Decoration & Visual Noise

- **Emoji infestation** — emojis in every header, bullet, table cell, or sentence opener. Strip all decorative emojis. Keep only an emoji that is itself the topic (e.g. an emoji shortcode in a docs page).
- **Inline bold spam** — `**...**` wrapping every noun phrase, hollowing out emphasis. Bold at most one phrase per paragraph, only where the reader truly needs to find it again.
- **Horizontal rule overuse** — `---` between every section as visual filler. Keep `---` only when it separates genuinely distinct top-level parts.
- **Decorative quote blocks** — `>` blocks labelled "💡 金句", "🌟 核心洞察", containing a paraphrase of the previous sentence. Delete or fold back into prose.

#### B. Hyperbole & Marketing Register

- **Marketing buzzwords** — 重磅 / 革命性 / 终极 / 杀手级 / 降维打击 / 全方位 / 深度 / 硬核 / 瞬间起飞 / game-changing / revolutionary / ultimate / cutting-edge / unleash / supercharge. Replace with the concrete claim, or delete.
- **Empty CTAs** — 立即升级 / 建议收藏 / 敬请期待 / 建议直接 xx / 建议拉满 / Don't wait! / Get started today! The "建议直接 xx" form imitates tech-bro Twitter prescription voice — formulaic recommendation without reasoning. Delete unless the article is literally selling something with a link to click, or the recommendation has real backing.
- **Hyped predictions** — "下期预告" with multiple emojis and superlatives. Reduce to a plain one-line "Next:" if it exists.
- **Sanitized opinions** — original critique softened into corporate-safe language ("存在严重的 X 问题，慎入" replacing "GLM 输出乱码"). Restore the bluntness from the source if available; otherwise flag to the user that opinions need their input.
- **Superlative escalators** — "最精髓的一招" / "更绝的是" / "神来之笔" / "教科书级" / "封神之作" / "史诗级" used to frame ordinary observations as legendary. The escalator is a verbal drum-roll the writer uses to manufacture importance. Drop the superlative and state what actually happened at its real scale.
- **Grandiose framing of trivial things** — "史诗级胜利" applied to a 3% improvement, "神操作" applied to a routine fix, often wrapped in scare quotes ("史诗级"胜利) as if the writer half-knows it's overblown. Strip the epic vocabulary; describe the actual scale.
- **Overphilosophizing trivia** — "这种 xx 的哲学，是一种极致的 yy 主义——既然 a，那就 b". Elevating mundane choices to "哲学" / "主义" / "美学" gives prose hollow profundity. Delete the philosophy framing and restate the plain observation it dressed up.

#### C. Forced Structure

- **Numbered grouping fetish** — "三大核心亮点 / 四大学习收获 / 五大优势" imposed on content that wasn't naturally trichotomous. Drop the grouping label and let the items stand on their own; merge or split as the content actually warrants.
- **Table fetish** — Markdown tables for what is really a short prose list, or two-column "维度 / 价值" tables where the second column just repeats the first in different words. Convert to prose or a plain bullet list. Keep tables only when there are ≥3 rows with ≥2 truly orthogonal columns of data the reader will scan.
- **Section template repetition** — every section follows the same 痛点 → 核心价值 → 表格 → CTA scaffold. Break the template. Different topics deserve different shapes.
- **Forced parallel ✅/❌ pairs** — "传统 X ❌ ... / 新方案 ✅ ..." applied to scenarios where the comparison is fake or one-sided. Drop and write the actual nuance.
- **总-分-总 wraparound** — opening with a thesis summary, listing examples, then closing with the same thesis paraphrased. The closing rarely adds information; it just restates the opener so the piece "feels complete". Either drop the closing summary or replace it with a genuinely new takeaway, anecdote, or open question. Humans often just stop after the last item.
- **Templated closing** — articles ending with a tacked-on "关键在于 xx" / "所以，xx" / "归根结底 xx" / "说到底 xx" line that arrives without setup and restates what was already said. The model adds it reflexively to "land" the piece. Delete unless the closing actually advances a new claim.

#### D. Information Loss

- **Topic drift via summarization** — concrete technical explanation compressed into a vague "核心洞察" tag. Restore the specifics from the source (the original is the ground truth — re-read it, don't invent).
- **Lost specificity** — exact prices, part counts, thresholds, model names replaced by "性价比逆天 / 性能拉满". Put the numbers back from the source.
- **Generic filler phrases** — "值得注意的是", "毋庸置疑", "不言而喻", "It's worth noting that", "In today's fast-paced world". Delete; they add zero information.
- **Manufactured pain points** — opening "你是否还在为 X 烦恼？" lists invented to set up the product. Keep only pain points the source actually raised.

#### E. Voice Erasure

- **Lost first-person voice** — author self-deprecation, jokes, anecdotes, complaints removed in favor of neutral marketing copy. Restore from source. If source had none, ask the user.
- **Uniform paragraph rhythm** — every paragraph the same length, every sentence the same shape. Vary. Some paragraphs should be one line; some should ramble.
- **Over-formal hedging** — "在某种程度上可以认为", "或许可以这样理解" added to claims the author stated plainly. Restore directness.

#### F. Sentence-Level Tics

These are the verbal mannerisms LLMs reach for when they want to sound punchy or precise. Each is fine once; in volume they become a fingerprint.

- **"看到 X 直接 Y" / "X 直接拉满" / "X 直接起飞"** — formulaic punchline construction ("看到这个性能直接震惊"、"体验直接拉满"). Rewrite as a plain statement of what happened or what changed.
- **"不是 X，而是 Y" / "Not just X — it's Y"** — forced contrastive rhetoric. Even when X and Y mark a genuine distinction, the explicit "不是X而是Y" frame is a high-frequency LLM signature: the model reaches for it whenever it wants a sentence to feel sharp. Prefer postfix ("Y，而不是 X"), drop X entirely and let context imply the contrast, or rewrite as "靠的是 Y / 关键是 Y / 实际上是 Y". Reserve the explicit "不是X而是Y" frame for cases where X is a real misconception the reader is currently holding AND no shorter form preserves the meaning. One use per article, max.
- **"这反而 X" / "反倒 / 倒是" rhetorical twist** — using 反而 / 反倒 / 倒是 as a connector to manufacture a counterintuitive turn ("这反而把解释推向了正确的方向", "这反而特别真实", "倒是把问题暴露得更清楚"). The model reaches for it to make a transition feel like it's revealing something, even when the prior and next sentences aren't actually in tension. Drop the connector and let the next sentence stand on its own; if the contrast is genuine, state the surprising fact plainly without the twist marker.
- **Parenthetical "比如 X" example padding** — "不可忽略的光子（比如可见光）", "一种典型的失败模式（比如训练崩溃）", "在某些情况下（例如高并发场景）". The example neither pins down the abstract claim nor tells the reader anything they couldn't infer; it's the model reflexively hedging with an "e.g." for safety. Either commit to the example as the actual subject ("发出可见光光子") and drop the abstract framing, or drop the parenthetical and let the abstract claim stand. Keep only when the example genuinely narrows an otherwise too-broad claim.
- **Postfix over-justification in parentheses** — a single parenthetical tacked onto a term to define, exemplify, or hedge it when the reader already knew what it meant: "电脑（一种计算机，e.g. 个人电脑、笔记本等）", "Python（一种解释型编程语言）", "Tmux（终端复用工具，类似 screen）". The model is padding because it can't help adding context. If the audience already knows the term, delete the parenthetical entirely. Keep it only when the term is genuinely unfamiliar to this audience and the gloss is load-bearing.
- **Post-hoc self-correction** — "X 是最好的方案。当然，准确来说，X 在 Y 场景下才是最好的，在 Z 场景下未必。" The qualification arrives after the claim was already stated absolutely, signalling the model hedging itself. Either commit to the qualified version up front, or commit to the absolute claim and drop the walk-back.
- **"换句话说 / 也就是说 / 简而言之"** opening a paraphrase that adds nothing — the previous sentence was already clear. Delete the paraphrase.
- **"无论是 X 还是 Y，都 ..." exhaustive enumeration** when the writer just means "for any case". Use the shorter form.
- **"要么 X，要么 Y，要么 Z" forced disjunction** — stacking 要么/要么/要么 (or "either ... or ... or ...") to dramatize a list of options. The frame inflates a plain "you can do A or B" choice into a portentous trilemma, and pads each branch with parallel structure. Drop the 要么 chain and state the options as a normal sentence or short list. Reserve 要么/要么 for cases where the mutual exclusivity is itself the point.
- **Manufactured exhaustive closure** — "三条路都是 X，没有第四条" / "二选一，没有别的" / "仅此而已" / "再无其他可能" tacked onto an enumeration to feel definitive. Exhaustiveness is rarely proven, just asserted — the model adds the closure to land the paragraph with finality. Delete unless the article actually argues why no other option exists. Pairs frequently with "要么/要么/要么"; when both appear, kill the whole construction together.
- **"真正的 / 真正意义上的 X"** as a vague intensifier ("真正的工程化", "真正意义上的现代 C++"). Either define what makes it "真正", or drop the qualifier.
- **Gratuitous Chinese-English code-mixing** — sprinkling English words into Chinese prose when a perfectly good Chinese term exists: "这是最 typical 的 handle 机制", "我们 deploy 一下这个 feature", "用 elegant 的方式 handle 这个 case". Slop signal — the writer is reaching for English to sound technical/cosmopolitan. Translate the English back to Chinese (`typical → 典型`, `feature → 功能`, `handle → 处理`). Keep English only for proper nouns, established jargon with no good Chinese equivalent (CUDA, RAII, lambda), code identifiers, or quoted CLI/API names.
- **Colon-fueled grand restatement** — "X：Y 在 Z 时代的最佳体现 / X：一种全新的 Y 范式 / X：开启 Y 的新纪元". The colon is followed by a portentous reformulation that adds no information, just rhetorical weight. Either delete everything after the colon, or replace with a concrete fact. Heuristic: if the post-colon clause could be cut without losing any information the reader didn't already have, cut it.
- **Decorative scare quotes** — `""` around a term that is neither an actual quotation, a coinage on first mention, nor genuine irony: `"故障美学"`、`"画图"`、`"原材料"`、`"获得了新生"`、`没有"无限软"的光子`. The model uses quotes to flag "this is a metaphor or loose term", but readers don't need that signal and the quotes accumulate into visual noise. **Default to no quotes.** Even on first-mention coinages or metaphorical adjectives, quotes are usually unnecessary if surrounding prose makes the sense clear — `没有"无限软"的光子` reads cleaner as `没有无限软的光子`. Reserve quotes for (a) real quotations, (b) a term whose unquoted form would be misparsed, or (c) genuine irony. When tempted to quote a metaphor, try the unquoted version first; if it reads fine, ship it unquoted.
- **Redundant English gloss after a Chinese term** — `故障美学（glitch art）`、`着陆页（landing page）`、`大模型（large language model）`、`渲染（render）`. The English in parens is padding for any reader who already understood the Chinese; the model adds it reflexively to sound bilingual or "precise". Drop the gloss. Keep it only when the Chinese rendering is non-standard or unfamiliar enough that the English is load-bearing for lookup (rare for established terms).
- **Postfix qualifier carrying the actual news** — Chinese-flavored inversion where the main clause states a generic fact and a trailing `主要靠 / 凭借 / 通过 / 得益于 / 借助 X` clause hides the actual point. Example: `近几年它们在前端动画里又火了一把，主要靠"故障美学"` — "故障美学" is the news; the front clause is filler. Rewrite by fronting the qualifier: `近几年以故障美学的姿态在前端动画中大受欢迎`. Heuristic: if deleting the trailing clause guts the sentence's information, it belonged at the front.
- **Essentializing tic** — "本质是 xx" / "归根结底是 xx" / "说白了就是 xx" / "本质上 xx" as a formulaic opener for a summarizing claim. Each is fine occasionally; in a piece with three of them the writer is using "I'll now summarize" as a verbal crutch. Drop the opener and let the claim stand on its own.
- **"所以，xx" / "因此 xx" formulaic conclusion connector** — paragraph-opener "所以" / "因此" with no real causal link to the prior paragraph. The model uses it to manufacture flow. Keep only when there's a genuine logical chain; otherwise delete or rewrite.
- **"最后那个 / 最后这个 X" callback opener** — referring back to a prior item with "最后那个" / "刚才说的那个" before adding commentary. Reads like a podcaster filling time. Either name the thing directly or restructure so the callback isn't needed.
- **"关键在于 xx" tail emphasis** — sentence appended at the end of a paragraph or article to "drive the point home", usually paraphrasing what was just said. The model adds it to feel conclusive. Delete unless "关键在于" actually introduces a new constraint or insight.
- **Forced analogy avalanche** — "这就好比博尔特来你生日派对" / "就像把法拉利开进胡同里" / "好比 X 干 Y" piled on without adding clarity. One vivid analogy lands; three in a row reads as the model performing wit. Keep the single best analogy, delete the rest, or just state the technical point directly.
- **Single-character verb / subject preference** — Chinese LLM writing reaches for one-character verbs to feel punchy where humans would naturally use the two-character form: 扔 / 拷 / 开 / 弄 / dm vs 丢弃 / 复制 / 启用 / 处理 / 发消息. Same with one-character subjects: `人在输入框里` reads abrupt where `人类在输入框里` reads natural. Rule: prefer the two-character version unless the one-character form is the established jargon (e.g. `跑` a process, `调` an API). Imperative verbs immediately preceding a config name — `开 ControlMaster` — may stay one character because the next noun supplies the context.
- **Em-dash followed by an explanation / punchline / consequence** — `X 是 Y 的——Z`、`X 别忽略——Y`、`这套门是 best-effort 不是事务——TOCTOU`. The em-dash isn't a real interruption; the model uses it to land a sharp clarification or "actually" reveal. Replace with a colon (when a definition follows), a period (next sentence), or rewrite so the load-bearing fact comes first. Reserve `——` for genuine parenthetical thoughts that interrupt the main clause, or for surrounding quoted dialogue.
- **"一个直接后果是 / 一个直接受益是 / 一个意外的副作用是" formula opener** — slot-and-fill connector the model uses to introduce an example or consequence. Reads scaffolded. Either delete the opener and state the consequence directly, or rewrite as "这导致 X" / "这意味着 X" / "由此 X" with a proper causal link only when the link is real.
- **Inverted goal-first + tail-suffix structure** — Chinese-flavored slop where the goal or condition comes first and the method comes second, capped with `就行 / 就够了 / 就有了`: `要离开本机，把单文件 bundle rsync 到远端就行` / `想本地追溯，自己包一层 shell 函数 tee 一份就行`. The forward order reads more direct: subject + action + result. Rewrite as `把 claude-dm 打包成单文件 portable-claude-dm 即可操控远端 Claude` — action first, then result via `即可` (used as a forward connector, not a tail suffix). Heuristic: if the sentence starts with `要 / 想 / 如需` and ends with `就行 / 就够了 / 就有了`, front the action.
- **Verb-as-spine sentence default** — every sentence built around a strong action verb when state-description would be more natural: `工作机制可以拆成两半` vs `工作机制由两部分组成`; `把状态压缩成 5 个` vs `采用 5 个状态`. The verb-driven version makes the writer sound like they're performing on the content rather than describing it. Mix in `由 X 组成 / 是 X / 包含 X / 属于 X / 由 X 构成` to vary the rhythm. If the technical reality is static (a structure, a relationship, a category), describe the state instead of dramatizing it as an action.
- **Triple-negation parallel** — `没有守护进程、没有注册中心、没有数据库` / `无 X、无 Y、无 Z` / `no daemon, no registry, no database`. The triple repetition turns a single property (lightweight, dependency-free) into a chant-like rhetorical device. Collapse to one statement: `不依赖守护进程、注册中心或数据库`. Reserve the triple-repeat form for genuinely climactic emphasis the author would actually use.
- **"一句话：X" / "简单来说：X" / "总之，X" totalizing opener** — putting `一句话：` / `简单来说：` / `总之，` / `归纳一下：` at the head of a sentence to introduce a restated definition. The opener performs "here comes the one-liner" without adding information, and the line that follows is usually a paraphrase of what the surrounding prose already conveyed. Drop the opener and let the line stand on its own. If the surrounding paragraphs already define the thing, drop both the opener and the line. Distinct from the term-colon "X：Y 的最佳体现" pattern: this one starts the sentence with a meta-marker word.
- **Translationese / literal English calques** — Chinese phrasings that read like word-for-word translations from English: `字面的`, `给定 X 的情况下`, `所谓的 X` when not signalling irony, `让我们 X` in non-tutorial prose, `在某种意义上`, `值得一提的是`. The model defaults to these because they map directly from English idioms it has more training on. Replace with native Chinese: `字面 → 直接 / 直观`, `给定 X 的情况下 → 假设 X / 在 X 下`, `所谓的 → drop`, `让我们 → drop or 我们`, `在某种意义上 → 某种程度上 / drop`.

### Phase 3: Rewrite

Rewrite section by section, applying the inventory. Rules:

1. **Source of truth is the original article.** Do not invent facts to replace deleted slop. If the slop hid actual information loss (e.g. AI rewrite dropped a number that wasn't in the input), flag it rather than fabricate.
2. **Preserve the author's stated facts, links, code blocks, and citations exactly.**
3. **Default to prose.** Bullets and tables must justify themselves; if a list has 2 items or a table has 2 rows, write it as a sentence.
4. **One emphasis per paragraph at most.** Usually zero.
5. **Match the source's level of formality and snark.** If the source has jokes, keep jokes. If the source is dry, stay dry.
6. **Don't add a conclusion paragraph** unless the original had one. AI slop loves to wrap up; humans often just stop.

### Phase 4: Validation

After the rewrite, read the result aloud (mentally) without comparing to the slop version. Ask:

- Would I believe a human wrote this, or does it still smell like an LLM?
- Did any concrete number, name, or claim from the original silently disappear?
- Is there any remaining emoji, table, or bold that I cannot defend?
- Does the voice match the rest of this author's known work (if available)?

If any answer is unsatisfactory, do another pass. Then deliver.

## Quick Reference

| Phase | Action | Goal |
|---|---|---|
| 1. Read | Identify voice, facts, slop scaffolding | Understand what to keep vs strip |
| 2. Inventory | Tag every slop instance against checklist | Know what's wrong before rewriting |
| 3. Rewrite | Strip scaffolding, restore facts and voice | Human-voice prose |
| 4. Validate | Read-through, check for residual slop and lost info | Ship-ready |

## Slop Pattern Cheat Sheet

| Category | Smell | Fix |
|---|---|---|
| Emoji 🚀✨🔥 in headers/bullets | Decoration without signal | Strip |
| 重磅 / 终极 / 革命性 / ultimate | Marketing register | Replace with concrete claim or delete |
| "三大核心 / 四大优势" | Forced trichotomy | Drop label, let items stand |
| "核心就三点：" / "先说结论：" | Lead with loud heading | Drop, let content lead |
| Tables with 2 rows or duplicate columns | Table fetish | Convert to prose |
| `**every noun phrase**` | Bold spam | At most one bold per paragraph |
| `>` block paraphrasing previous line | Decorative quote | Delete |
| "立即升级！敬请期待！" | Empty CTA | Delete unless actually selling |
| "你是否还在为 X 烦恼？" | Manufactured pain point | Delete unless source raised it |
| "性价比逆天" | Embrassive advertisement | Replace with rational data |
| Softened critique | Sanitized honesty | Restore the bluntness from source |
| Same shape every section | Template repetition | Vary structure |
| `---` between every section | Filler dividers | Remove most |
| "看到 X 直接 Y" / "直接拉满" | Punchline tic | Plain statement |
| "不是 X，而是 Y" (even when contrast is real) | High-frequency LLM signature | Postfix ("Y，而不是 X"), drop X, or rewrite — at most once per article |
| "这反而 X" / "反倒 / 倒是" | Manufactured plot twist | Drop the connector |
| "X（比如 Y）" parenthetical example | Reflexive e.g. padding | Commit to Y as subject or drop the parens |
| Claim → "当然，准确来说 ..." walk-back | Post-hoc self-correction | Commit up front |
| "换句话说 / 简而言之" + paraphrase | Empty restatement | Delete the paraphrase |
| "真正的 / 真正意义上的 X" | Vague intensifier | Define or drop |
| 中英混搭 ("最 typical 的 handle 机制") | Faux-cosmopolitan code-mixing | Translate back unless jargon |
| "X (long justification explaining X)" | Postfix over-justification | Delete unless gloss is load-bearing |
| "X：Y 的最佳体现 / X：全新的 Y 范式" | Colon + grand restatement | Cut post-colon clause or replace with fact |
| `"故障美学"` / `"画图"` decorative quotes | Scare-quote tic | Drop quotes unless real quote / coinage / irony |
| `故障美学（glitch art）` redundant gloss | Bilingual padding | Drop English unless load-bearing for lookup |
| `又火了一把，主要靠 X` (key info trailing) | Postfix qualifier | Front the load-bearing clause |
| "本质是 / 归根结底 / 说白了就是 X" | Essentializing tic | Drop opener, let claim stand |
| "所以，xx" / "因此 xx" without real causal link | Manufactured flow | Delete or rewrite |
| "最后那个 X" / "刚才说的那个" callback opener | Podcaster filler | Name the thing or restructure |
| Tail-appended "关键在于 xx" | Tacked-on emphasis | Delete unless new constraint |
| "这就好比 X 来 Y" piled on, 比喻满天飞 | Analogy avalanche | Keep one, drop the rest |
| "最精髓的一招 / 更绝的是 / 神来之笔" | Superlative escalator | Drop, state the observation plainly |
| "史诗级胜利" applied to trivial outcome | Grandiose framing | Strip epic vocab, state real scale |
| "建议直接 xx / 建议拉满" | Tech-bro CTA voice | Delete unless real recommendation |
| `这种"xx"的哲学，是一种极致的 yy 主义` | Overphilosophizing trivia | Restate the plain observation |
| 总-分-总 wraparound (closing repeats opener) | Forced symmetry | Drop closing or replace with new takeaway |
| Final tacked-on "关键在于 / 所以 / 归根结底" line | Templated closing | Delete unless it advances new claim |
| "要么 X，要么 Y，要么 Z" stacked disjunction | Forced trilemma | Plain sentence; reserve for real mutual exclusivity |
| "三条路都是 X，没有第四条 / 仅此而已" | Manufactured exhaustive closure | Delete unless exhaustiveness is actually argued |
| "扔 / 拷 / 开" 单字动词、"人" 单字主语 | Punchy single-char tic | Use two-char form (放到 / 复制 / 启用 / 发消息 / 人类) unless established jargon |
| `——` after main clause adding clarification / punchline | Em-dash punchline | Use colon, period, or front the load-bearing fact |
| "一个直接后果是 / 一个直接受益是" formula opener | Scaffolded connector | Delete or rewrite as natural causal link (这导致 / 这意味着) |
| "要 X，把 Y 干 Z 就行 / 就够了 / 就有了" inverted goal-first | Inverted structure with tail suffix | Front the action; `即可` as forward connector is fine |
| "拆成两半 / 压缩成 5 个" verb-spine where state would do | Action-dramatized state | Use 由...组成 / 采用 / 包含 / 属于 |
| "没有 X、没有 Y、没有 Z" triple negation parallel | Chant-like repetition | Collapse to "不依赖 X、Y 或 Z" |
| "一句话：X / 简单来说：X / 总之，X" opener | "Here comes the one-liner" pose | Drop opener; let the line stand or remove if redundant |
| "字面的 / 给定 X 的情况下 / 让我们 X" calques | Translationese | Replace with native phrasing or drop |

## Notes

- This skill is language-agnostic. The example phrases above are Chinese and English because those are the most common slop dialects, but the patterns (decoration, hyperbole, forced structure, information loss, voice erasure) appear in every language LLMs write.
- The checklist is descriptive, not exhaustive. If you spot a slop pattern not listed, fix it anyway and consider whether it deserves a new entry.
- When in doubt about whether something is slop or genuine author intent, ask the user — especially for opinion-laden or critical passages.
