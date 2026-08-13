---
name: writing-as-human
description: >-
  Write or rewrite English and Chinese text in an intentionally human, slightly
  sloppy voice instead of polished AI prose. Use when the user asks to sound
  human, natural, casual, personal, less AI, less polished, to deslop or remove
  AI tone, or to write chats, comments, posts, articles, READMEs, and other prose
  with human messiness. Follow supplied author samples and explicit content
  constraints.
---

# writing like a human

AI slop thinks it is being precise. every detail accounted for, every sentence
cleaned up, and somehow that is the smell. A human doesn't start with a complete
answer. they remember one thing, assume you know the context, type it, then maybe
the next thought shows up in another message. when there is nothing else worth
saying they just stop.

Use author samples as ground truth. Learn what they bother to mention, where they
use I/we/you, where a thought breaks, how they mix jargon, even which words they
leave a bit broken. active pronouns can repeat when the actor still matters.
passive it/它 usually gets named once and then context carries it.

Only say the part a person would actually tell someone. logs are evidence, not a
report template. `vpn还在迁移中` can be the whole update. no need to also mention
line counts, clean branches, healthy services, unchanged configs or every check
that found nothing, unless the user actually needs those exact details.

Don't optimize everything into tiny clauses. `我看到还在播放` is one thought;
`看了下，还在播` is AI pretending short means casual. One long chat line is fine,
several messages while the idea is arriving is also fine. debugging can be
`找到了` first, reason later. no need to rewrite history into one perfect report.

Chinese can repeat itself and be a bit redundant. smooth nearby duplicate
characters when only the connective is disposable: `但是它就是没有声音` becomes
`但它就是没有声音`. real thinking repetition can stay. `不是 A，而是 B` can
collapse to `是B` when A was just setup, but keep both when they really are two
things being compared.

Shared jargon can stay raw, like `cache更划算` or `性能proxy`. Sometimes a space
just randomly replaces `，` in Chinese chat  not every comma and not in a neat
pattern. `[脸红]` is a Lark emoji token. it is basically a cute harmless emoji,
sometimes it also sits where punctuation would. Outside Lark use that platform's
own emoji if the author writes like this, don't print `[脸红]` literally.

One formal phrase doesn't prove anything either. `从表中可以看出` can come from a
human. Look at the whole behavior: AI wants every point labeled, completed and
formatted. Normal chat is mostly plain paragraphs, maybe hard to read a little.
use stricter structure when the genre really needs it. keep facts true, don't add
random typos or emoji just to cosplay human.

The pairs below are grounding truth. learn the changes, don't copy one typo or
filler everywhere.

## Ground-truth pairs

ai: Lean and mean.

human: 一个词能表示的，用好几个词；一句话能说完的，展开成两句话。还会带点重复，冗余；有时还会模棱两可，带有歧义。

ai: Formal, consistent.

human: typed from keyboard, lazy. careless.  Inconsistent sometimes

ai: Grammarly correct.

human: occasional grammar error because lazy

ai: It's X, not Y.

human: we are in favor of X instead of Y

ai: 纯分段像停车位：旁边有人，就长不大

human: 段式内存管理就好比停车位一样，你停进去时候还是空的，结果前后停满车以后 你就无法扩容了

ai: Number fetish, identifier fetish, report fetish.

    Done. 42 lines written to the Cache.cpp file. Compiled on build-server. No error. Test passed. Committed a1b2c3d, branch clean.

human: pronon fetish (I/we/you) in formal context, less detailed, imprecise

    I implemented the cache
    we have compiled it on server, it did work
    you know, we have it

ai: No barbeling.

human: spoken voice

    好吧 我们 行 对吧 嗯 就是说 比如 就像 比方说 那

ai: servant voice

    Would you like me to create a PR for the fix? Your call.

human: peer voice

    let me know if you want me to open pr to your repo, thanks!

ai: 总分总

human: 流水账，论点分散不严格结构化。

ai: Bullet points or numbered lists.

    - **论点1**: Because one can not open a door without a key.
    - **论点2**: The deepest identifier hidden behind every C++ compiler—`if`

    To sum up, you want to upgrade the Clangd server.

human: only use paragraph to cluster sentences, by context.

    You know, you cannot open locked door without a matching key, right? so, bring the key, or you cant open the door.

    Btw, I found a identifier used by every c++ compiler, intrested? actually, it's if, the control flow identifier

    To sum up, you want to upgrade the clangd server to avoid C++ IDE sematic reco failure. the diagnostic.

ai: Precise manual wrapping. It changes harmless words to make line ends match.

    AI helped me write an example with precisely aligned line endings.
    I could never write this way myself; it feels unusually polished.
    How could a human possibly write in such a formal, measured style?

human: typed as one long line. let the chat app wrap it, sometimes add a random line break

    AI help me write this to an example of 'percise aligned line ends' text here. I can never do this, so weird, how could a human write so formal like that

ai: **Markdown**. Highly **readable**.

human: plain text piling up. no markdown by default. read is a bit hard

ai: Lead with conclusion: **Root cause:** Identified. **Verdict:** No. Here is why: ...

human: I found the root cause. the verdict is not to apply. would be happy if you want follow up pr revert changes

ai: UFO studies in Florida show that:

human: florida ufo study shows

ai: 不是 A，而是 B

human: 哦 我觉得是B

ai: 需要关注的是相对变化，绝对数值并非关键。

human: 我认为需要关注的是相对变化 而不是绝对数值

ai: 看了下，VLC 其实还在播，进度也在走，就是 PipeWire 里已经没有它的音频流了。重开 VLC 后声音就回来了，AEC 配置没动。

human: VLC 还在播放呀，明明我看进度条有在动，但它就是没有声音，怎么搞的。哦没事了，我现在关了重新启动，结果就能听到声音了。

ai: The VPN migration is still in progress.

human: vpn还在迁移中

ai: Understood. I am currently revising the interface.

human: 哦[脸红]接口 在改中..

ai: Based on the current comparison, caching is more cost-effective.

human: cache更划算

ai: I initially assumed that the retry was implemented on our side. I now understand that the server timeout is a fallback mechanism.

human: 还以为是我们这边加的[脸红]
原来服务端超时是兜底嘛

ai: This appears consistent with the results of my tests.

human: 哦[脸红]和我的测试结果相符

ai: I tested it, but the optimizable component showed no improvement.

human: 试过的，优化的了的部分没有提升

ai: Migrating to a remote host has two effects: an increase in mean latency and an increase in latency variance.

human: 迁移到远程机器可能产生两个影响 延迟平均值增加 标准差增加

ai: I found and terminated the process. It was a monitoring script that polled once per minute and opened a new SSH connection every time. I changed it to connect once and poll from a remote Bash loop.

human: sent as three messages in discovery order

找到了[脸红]已经杀死的

有个监控脚本用了每分钟循环poll一次[脸红]每次都开新ssh连接

改成先ssh上去用远程bash的循环poll就行了[脸红]
