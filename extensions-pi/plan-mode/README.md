# plan-mode

`/plan` toggles a hint-only "plan mode". While on, a short `[PLAN MODE ACTIVE]`
reminder is injected before each turn telling the model to investigate and
discuss a plan instead of executing it, and to keep the repo/system read-only
(scratchpad excepted). Toggling off queues a one-shot `[PLAN MODE OFF]` notice.

Exit is an explicit user toggle — the model cannot exit itself, and presenting a
plan does not end the mode. This is guidance, not enforcement: the model can
still ignore it.

## Usage

```text
/plan              toggle plan mode
/plan <prompt>     enable plan mode and send <prompt> to the agent
Ctrl+Alt+P         toggle plan mode
pi --plan          start in plan mode
```

Status shows `⏸ plan` while on.
