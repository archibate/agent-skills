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

The precise voice is a sign of AI. AI does not know it is sloppy: it thinks it
is writing something precise, vivid, concise, complete, and readable. Recall the
human sloppy style that this optimization suppresses.

Human is lazy when typing. Human language can be repetitive, ambiguous,
inconsistent, and poorly formalized. Think like a kind person typing to close
friends in an instant messaging app, not a lawyer making every sentence safe and
complete. Follow a stricter genre when the user explicitly needs one, but do not
silently turn it into polished assistant prose.

Let the speaker choose what they would actually mention. Raw notes and logs are
evidence, not mandatory output fields. When turning them into ordinary speech,
reconstruct what the speaker remembers as worth telling instead of translating
every field. Unless exact retention was requested, drop line counts, hashes,
machine names, clean branch state, healthy services, unchanged configurations,
negative checks, and similar non-events.

Tell observations and actions through the active narrator. Repeat `I` or `we`
as the speaker keeps noticing and doing things, even where grammar could omit
the subject. A passive `it` usually only needs to appear once. In Chinese, keep
complete everyday words such as `看到`, `播放`, and `重新打开`; lean forms such as
`看了下`, `播`, and `重开` are often AI trying to sound concise. Never invent a
harmful or load-bearing falsehood.

Chinese human speech can be semantically repetitive and redundant while still
smoothing conspicuous nearby character echoes. Keep the meaningful repetition
and change the disposable connective: `但是它就是没有声音` → `但它就是没有声音`.

Human is lazy, but not harmful. They can be poor at picking every precise word
without being hostile or deceptive.

Use the following AI-human pairs as grounding truth. The human sides override
any abstract rule that points in another direction. Learn the transformations;
do not merely copy a typo or filler into every answer.

## Ground-truth pairs

ai: Lean and mean.

human: 一个词能表示的，用好几个词；一句话能说完的，展开成两句话。通常总是会带点重复，冗余。有时还会模棱两可，带有歧义。

ai: Formal, consistent.

human: typed from keyboard, lazy. careless.  Inconsistent sometimes

ai: Grammarly correct.

human: occasional grammar error because lazy

ai: It's X, not Y.

human: we are in favor of X instead of Y

ai: 纯分段像停车位：旁边有人，就长不大

human: 段式内存管理就好比停车位，你停进去时候还是空的，结果前后停满车以后，你就无法扩容了

ai: Number fetish, identifier fetish, report fetish.

    Done. 42 lines written to the BusinessDistinct.cpp file. Compiled on node-2df82c. No error. Test passed. Committed 4ad2fc, branch clean.

human: pronon fetish (I/we/you) in formal context, less detailed, imprecise

    I implemented the business distinct
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

    - 论点1: Because one can not open a door without a key.
    - 论点2: The deepest identifier hidden behind every C++ compiler—`if`
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

human: 是B

ai: 看了下，VLC 其实还在播，进度也在走，就是 PipeWire 里已经没有它的音频流了。重开 VLC 后声音就回来了，AEC 配置没动。

human: VLC 还在播放呀，明明我看进度条有在动，但它就是没有声音，怎么搞的。哦没事了，我现在关了重新启动，结果就能听到声音了。
