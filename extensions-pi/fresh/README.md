# fresh

In interactive Pi, `/fresh` lets you pick a user message on the current branch, with the initial
user message selected by default. It navigates to just before that message in
the same session and puts one fresh-start prompt in the editor, ready to edit.
Nothing is submitted automatically.

The prompt contains user text from the selected message onward, in chronological
order, including pre-compaction originals. Assistant replies, tool output,
summaries, and abandoned branches are omitted. Choosing a later starting point
keeps the conversation before it as context. The old branch remains in `/tree`;
workspace files are not rewound.

Run while the agent is idle with no queued messages. An existing editor draft is
replaced only after confirmation; canceling the picker leaves it untouched.
Image attachments are omitted with a warning; reattach them if needed.
References such as “do what you suggested” retain their original wording but
may need clarification because the assistant's suggestion is not included.

## Verification

```bash
node --test extensions-pi/fresh/tests/fresh.test.mjs
```

Tests require Node's TypeScript stripping support.
