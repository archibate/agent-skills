---
name: herdr-team
description: "Orchestrate helper coding agents in Herdr panes so that delegation saves cost: the main agent briefs, steers and reviews, and cheaper models do the scans and long edits. Use with Herdr's own skill (`herdr --skill`) before starting, briefing, steering, waiting on or resuming a helper agent. Requires HERDR_ENV=1."
---

# Herdr team

A top-up to Herdr's own skill. Run `herdr --skill` first for the CLI; this file adds what makes delegation pay.

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
- Each turn sends the helper's whole context. The provider caches it for a short time (Kimi: less than an hour), and a cached read costs little. The first turn after the cache expires pays for the whole context: one such turn of 410k tokens took 9% of Kimi Code's 5-hour window. Before a helper with a large context waits on a long job, compact it while the cache is warm (Kimi: `/compact <what to keep>`).
- Close the helpers you started when their work is done; keep a pane only while its context is worth more turns.

## User feedback

These are real conversation snippets cited from history sessions between user and assistant. Each lesson is a pattern corrected by user feedback. The lessons are negative examples to criticize, not to imitate. Manage with `$apply-feedback` skill.

**IMPORTANT:** BEFORE your next response matches ANY of the assistant trajectory below, apply the corresponding user feedback (last message in each lesson) IMMEDIATELY.

<lessons>
  <lesson name="steer-a-plan-change-into-the-current-turn">
    <message role="user">
      why is arrange engine only tries two angle, that doesn't sound what I used in bambu studio which I recall can rotate arbitary angle at click
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="1">{"command":"herdr agent prompt cli \"When you come to fault 2, first read /tmp/kimi-cli/BRIEF-fix-2.md: two changes to its plan. Go on with fault 1 now.\" (...)","description":"Queue the fault 2 plan change for the cli agent"}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      (...)
      I also gave the `cli` agent two changes for fault 2. They are queued until it finishes fault 1:
      - The turn finder tries every turn in 1° steps, not only the arranger's angles. (...)
      - Plain `--arrange 1` also goes on to the arranger.
    </message>
    <message role="user">
      also, your message to 'cli' kimi seems follow-up, not steering, if that's intentional.
    </message>
  </lesson>
  <lesson name="install-herdr-integration-for-each-agent-kind">
    <message role="user">
      (...) you are now in herdr, you can use its --skill, it can be used to orchestrate agent team (...)
    </message>
    <message role="assistant">
      (...)
      - It writes its report to `/tmp/kimi-cli/REPORT.md`. Herdr shows kimi as "idle" even while it works, so I wait for that file, not for the herdr status.
    </message>
    <message role="user">
      is it herdr bug?
    </message>
    <message role="assistant">
      Yes, the "idle while working" part is a fault in herdr. (...)

      `herdr agent explain cli` shows the cause. herdr's rules for Kimi (...) do not match the screen of Kimi Code 2.5.3. No rule for "working" matches, so herdr falls back to `idle` (...)

      There are two ways to fix it:
      1. **A local override:** I write a Kimi rule file with these three patterns corrected, and check it with `herdr agent explain` on the live pane. (...)
      2. **A report to herdr:** I write the evidence above as an issue. (...)
    </message>
    <message role="user">
      what a error-prone implementation of herdr, I thought it can use some integration rather than hard-coded UI elements.
    </message>
    <message role="user">
      ok, do we want to install to all agents we are using, including claude. so is the mistake won't happen again
    </message>
  </lesson>
  <lesson name="one-shot-helper-task-via-kimi-p">
    <message role="user">
      (...) you are now in herdr, you can use its --skill, it can be used to orchestrate agent team, especially using the cheaper models to do the extensive edit and fix, once direction is set, or launch read-only scan agents to scan or verify faults. this saves massive claude opus model cost, and opus only as an orchestrator and talk me to track big goals.
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="1">{"command":"herdr pane run wA:pB \"(...) kimi --yolo --add-dir /tmp/kimi-cli (...)\" (...)","description":"Start kimi behind the memory gate in the new pane"}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="2">{"command":"herdr agent prompt cli \"Read /tmp/kimi-cli/BRIEF.md and do it.\" (...)","description":"Send the brief to the kimi agent and check it started"}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="3">{"command":"end=$((SECONDS+5400)); quiet=0; while [ $SECONDS -lt $end ]; do if [ -f /tmp/kimi-cli/REPORT.md ] && ! herdr agent read cli --source visible --lines 30 2>/dev/null | rg -q 'Working…|thinking…|esc to interrupt'; then (...) fi; if herdr agent read cli --source visible --lines 30 2>/dev/null | rg -q 'Allow|Approve|\\[y/n\\]|Yes, '; then echo \"kimi asks for approval\"; exit 2; fi; sleep 20; done; (...)","description":"Wait in the background until the kimi report is written and the agent stops","run_in_background":true}</tool_call>
      </tool_calls>
    </message>
    <message role="user">
      to today, do you found herdr orchestration saving money, or costing more, or low effciency, so far?
    </message>
    <message role="assistant">
      (...)
      | Cost | Cause | Change |
      |-|-|-|
      | I had to write my own waits | herdr shows Kimi as "idle" while it works, so I waited on report files. One wait did not see an approval prompt, and one did not see the agent die | For a one-shot task, use `kimi -p`, which ends when the task ends. Use a pane only for long work that I must steer |
      (...)
    </message>
    <message role="user">
      ok, keep learning herdr orchestration lesson, to save cost without ineffciency.
    </message>
  </lesson>
  <lesson name="auto-mode-for-a-helper-in-its-own-worktree">
    <message role="user">
      (...) especially using the cheaper models to do the extensive edit and fix, once direction is set (...)
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="1">{"command":"herdr pane run wA:pB \"(...) kimi --yolo --add-dir /tmp/kimi-cli (...)\" (...)","description":"Start kimi behind the memory gate in the new pane"}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="2">{"command":"herdr agent send-keys cli 1 (...)","description":"Approve once the delete of the agent's own partial boost clone"}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      The `cli` agent asked to delete a folder before it builds the libraries that slicer-cli needs. The folder was its own half-finished copy of boost, from 12:07, in its own build folder. I approved that one command. (...)
    </message>
    <message role="user">
      to today, do you found herdr orchestration saving money, or costing more, or low effciency, so far?
    </message>
    <message role="assistant">
      (...)
      | Cost | Cause | Change |
      |-|-|-|
      (...)
      | Approval prompts | Kimi's `--yolo` still asks before `rm -rf`, so I must check each one | In an agent's own worktree, start it with `--auto` |
      (...)
    </message>
    <message role="user">
      ok, keep learning herdr orchestration lesson, to save cost without ineffciency.
    </message>
  </lesson>
  <lesson name="helper-agent-starts-outside-the-gate">
    <message role="user">
      (...) you are now in herdr, you can use its --skill, it can be used to orchestrate agent team, especially using the cheaper models to do the extensive edit and fix (...)
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="1">{"command":"herdr pane run wA:pB \"NEED=1024 MEM=3072 tools/gate.sh kimi --yolo --add-dir /tmp/kimi-cli --add-dir (...)\" (...)","description":"Start kimi behind the memory gate in the new pane"}</tool_call>
      </tool_calls>
    </message>
    <message role="user">
      a kimi was killed due to SIGKILL, did you see that? by gate
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="2">{"command":"herdr pane run wA:pB \"NEED=1024 MEM=3072 gate kimi --yolo --add-dir /tmp/kimi-cli --add-dir (...) -S (...)\" (...)","description":"Resume the cli agent's own session behind the new gate"}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      Yes, I see it now, but I did not see it when it happened. My background wait watched only for the agent's report or an approval prompt, not for the agent stopping. (...)
      - I resumed the `cli` agent's own Kimi session, behind the new gate, so it has its full history. (...)
    </message>
    <message role="user">
      gate kills kimi, not kimi's subtask? sounds off?
    </message>
  </lesson>
  <lesson name="keep-helpers-off-the-quota-under-test">
    <message role="user">
      also follow-up a task: (...) today I’ll use my newly-subscribed kimi K3.1 pro in pi or kimi code to see if their advocated 3D generation ability extrapolates to 3D printing agent (...) this replaces deepseek with kimi in agent slicer usage, so judge if the improvement in stability and quality justifies kimi's extra costs.
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="1">{"command":"(...) herdr pane run \"$p\" \"NEED=1024 MEM=3072 tools/gate.sh kimi --yolo (...)\" (...) herdr agent prompt judge \"Read /tmp/kimi-cli/BRIEF-judge.md and do it.\" (...)","description":"Start a second kimi agent to write the design-job scorer"}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="Bash" tool_call_id="2">{"command":"(...) ./batchmix.sh kimi:k1-03a:03a kimi:k1-04d:04d (...) kimi:k2-18a:18a > kimi-batch.log 2>&1 (...)","description":"Run the Kimi exam batch, one run at a time, beside the DeepSeek batch","run_in_background":true}</tool_call>
      </tool_calls>
    </message>
    <message role="assistant">
      (...)
      **Kimi plan limit:** the 5-hour limit is at 29% and resets at 17:06. My `cli` helper also uses it while it builds. I log the use every 2 minutes. If it passes 85%, I stop the Kimi queue and run the rest after 17:06, so that no run fails on the limit.
    </message>
    <message role="user">
      to today, do you found herdr orchestration saving money, or costing more, or low effciency, so far?
    </message>
    <message role="assistant">
      (...)
      | Cost | Cause | Change |
      |-|-|-|
      (...)
      | A slower comparison | The helper agents use the same Kimi 5-hour limit as the Kimi runs under test. By difference, the helpers took about 40% of the window, so the last 5 Kimi runs wait until 17:06 | While Kimi is under test, use pi with DeepSeek for helper work, or plan the helper work for after the runs |
    </message>
    <message role="user">
      ok, keep learning herdr orchestration lesson, to save cost without ineffciency.
    </message>
  </lesson>
</lessons>
