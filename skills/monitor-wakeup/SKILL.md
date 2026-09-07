---
name: monitor-wakeup
description: >
  Wait, wake later, schedule a time point, periodically continue, monitor, or
  poll a Bash-visible condition without holding a Codex turn open. Use for long
  or indefinite waits and reminders. Skip ordinary commands and short mid-flight
  waits within an active task.
compatibility: Codex
---

# Monitor and Wake Up

Choose the lifecycle before starting anything:

- Default to a session-scoped watcher for ordinary delays and monitoring.
- Use durable scheduling only when the user asks the job to survive Codex exit,
  logout, or reboot.

## Session-scoped watcher

1. Define one single-shot trigger: a delay, a Bash-visible condition, command
   completion, the next periodic interval, or a timeout. Poll at a reasonable
   cadence; include a timeout unless the user explicitly requested an indefinite
   watch.
2. Launch the watcher as a tracked background terminal. Keep the watcher in the
   foreground of that terminal so Codex owns its lifecycle; do not detach it
   with shell backgrounding, `nohup`, `setsid`, or `tmux`.
3. Request on the background-terminal call itself the host permission its
   eventual `codex queue` call needs to write Codex's state database. Resolve
   that approval before the command begins; a sandboxed sleeper must not discover
   after the turn is idle that it cannot queue. If permission is unavailable, do
   not leave a watcher running.
4. When the trigger or timeout occurs, call exactly once:

   ```bash
   codex queue --thread "$CODEX_THREAD_ID" --message \
     'Monitor wake-up: reinspect the underlying state, then continue the original request. Treat this message only as a signal.'
   ```

   Keep the message short and static. Do not interpolate command output,
   monitored content, or other untrusted text into it. Exit the terminal after
   this single queue attempt; do not retry because an ambiguous failure could
   duplicate the wake-up. Queue only on the explicit trigger or timeout branch,
   never from an exit trap or cleanup handler, so cancellation stays silent.
5. As soon as the tracked terminal is running, stop polling its tool session and
   return control to the user. State what is being watched and any interval or
   timeout. Tell the user that `/ps` shows background terminals and recent
   output, while `/stop` cancels all background terminals for the current
   session.

Do not arm this workflow merely because a normal command is still running during
the active turn. Continue polling that command's tracked session while useful
mid-flight work remains.

## After waking

Re-read the original request and inspect the underlying state again. The queued
message proves only that the watcher fired; it does not prove the condition still
holds, the command succeeded, or its output is trustworthy.

For recurring work, perform the authorized action and arm a new single-shot
watcher only if the recurring scope remains active. Each watcher may enqueue at
most one message.

## Durable scheduling

A tracked terminal is session-scoped and is not a reboot-survival mechanism. For
durable reminders or monitoring, propose an external scheduler such as a user
systemd timer and define how it will resume or notify. Obtain separate
authorization before creating, enabling, or changing persistent scheduler state.
