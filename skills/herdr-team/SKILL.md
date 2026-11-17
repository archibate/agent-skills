---
name: herdr-team
description: "Orchestrate helper coding agents in Herdr panes so that delegation saves cost: the main agent briefs, steers and reviews, and cheaper models do the scans and long edits. Use with Herdr's own skill (`herdr --skill`) before starting, briefing, steering, waiting on or resuming a helper agent. Requires HERDR_ENV=1."
---

# Herdr team

A top-up to Herdr's own skill. Run `herdr --skill` first for the CLI; this file adds what makes delegation pay. If `references/lessons.md` exists beside this file, read it too: the user's corrections of past mistakes with Herdr teams.

## When to delegate

- Delegate a self-contained task once its direction is set: a scan or reproduction across many files, a long edit, a test harness. Keep decisions, review and the talk with the user in the main agent.
- Do a task of a few tool calls yourself: a brief and a review cost more.
- For a one-shot task with a file result, run the helper without a pane, as a background command (`kimi -p "<prompt>"`). It ends when the task ends, and that end is the notification. Use a pane for long or steered work, or work the user wants to watch.

## Before the first helper of a kind

- Run `herdr integration install <kind>` once, so that the agent reports its own state. `herdr agent get <name>` then shows `screen_detection_skipped: true`. Without it Herdr reads the screen, and its rules can lag the agent's UI: Kimi Code 2.5 showed `idle` while it worked. Claude's integration reports only the session, by design; its screen rules hold.
- Know the helper's quota. A plan's short window (Kimi Code: 5 h) is the real limit, not money. When a helper and a model under test share a plan, the helper slows the test: give the helper another provider, or run it after the test.

## Start

- Split a sibling pane with `--no-focus` and start the agent with `herdr agent start <name> --kind <kind> --pane <id> -- <agent args>`.
- Start the agent outside any memory gate, and have it send its heavy commands through the gate. A memory limit kills the largest process in its group, and an agent in a small group can be that process.
- Give a helper that edits its own worktree or branch, then start it in its no-approval mode (Kimi `--auto`), so that each approval prompt does not cost the main agent a check. Answer an approval only after you check what the command touches.

## Brief

- Write the brief to a file and prompt `Read <file> and do it.`
- Brief as to a peer: the goal, what is known and ruled out, the paths, the hard rules (gate, write scope, no posting), the report file and its form, and "then stop". Split the work in phases: investigate and report, review, then fix.
- Ask for evidence marked as seen or inferred, and check two claims yourself before you act on the report.

## Wait, steer, recover

- Wait with `herdr agent wait <name>`, or for the report file, in a background command. Stop waiting also when the agent is gone from `herdr agent list`.
- Steer a change that affects the current turn: `herdr agent prompt <name> "<text>"`, then `herdr agent send-keys <name> ctrl+s` (Kimi). A queued prompt arrives only after the turn, and a helper often does a whole brief in one turn.
- When an agent dies, find why (`journalctl -k`, `journalctl --user`), resume its own session (Kimi: `kimi -S <id>` from `kimi session list`), and tell it what was killed and what to check first.

## Costly resources

- A build costs more than a worktree: build each target once, and check out the other commits in that tree for before-and-after tests.
- Close the helpers you started when their work is done; keep a pane only while its context is worth more turns.
