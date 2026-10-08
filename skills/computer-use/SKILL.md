---
name: computer-use
description: >-
  Operate and test graphical applications through screenshots, coordinates, and
  input events using available shell tools or platform automation. Use for desktop
  GUI interaction, game reproductions, and scripted visual workflows, including
  private headless desktops.
---

# Computer use

A vision-capable agent needs an action/capture tool and a way to read images.
Shell commands plus an image-capable file reader satisfy this contract. Use the
available automation backend; do not make a dedicated MCP or wrapper a prerequisite.
Prefer an existing CLI or API when the task does not require exercising the GUI.

## Establish the session

Before execution tests, apply `$e2e-side-effect-safety` if available. Establish
ownership and effective routing before launching or sending input. Continue
autonomously when the session is verified private and non-disturbing; otherwise
inspect or isolate it, and ask before unavoidable interaction with a shared desktop.

For local tests, own the desktop, application instance, config/profile, writable
data, screenshots, and process lifecycle. A separate display alone does not isolate
saves, audio, credentials, network traffic, or single-instance application IPC.
Use private fixtures and verify application-specific paths and fallbacks. Silence
the test application's output without changing the user's audio. For offline tests,
verify that the app cannot contact external services; headless is not offline.
Bound runtime and resource use so the private test does not monopolize the host.

Choose tools against the actual session:

- X11: read [the Xvfb/Openbox reference](references/x11.md) for a private desktop,
  screenshot capture, and `xdotool` events.
- Wayland: use a private compositor/session and its supported capture/input tools.
  Verify that both address that session; global input injection can reach the user's
  real seat. X11 tools only cover applicable Xwayland clients, not every native app.
- Other platforms: use their available automation tools with a verified private
  session, VM, simulator, or explicitly authorized device. Preserve the same loop.

Record the session identifier, owned process identities, application/window,
capture dimensions, input coordinate space, and scratch directory. Recheck these
after a restart or routing change. Do not silently fall back to the user's desktop.

## Observe, act, observe

1. Capture a fresh screenshot from the target session and actually read the image.
   Confirm the expected application, state, geometry, and focus.
2. Identify the target in that image. Map displayed image coordinates to the input
   tool's coordinate space, accounting for resizing, crop offsets, window borders,
   and display scaling. Keep this transform explicit.
3. Send the intended click, drag, scroll, text, or key events. Pair held keys and
   buttons with releases, including error/cancellation cleanup. Use actual input
   events when input behavior is what the test measures.
4. Wait for the application to process the action, then capture and inspect the
   result. Prefer bounded state/readiness checks where available; a command exit
   code or fixed sleep alone does not prove the intended transition occurred.

Reobserve after unexpected dialogs, navigation, geometry changes, focus loss, or
failed expectations. Do not keep clicking old coordinates to recover blindly.
Logs and application instrumentation can establish mechanics or hidden state;
visual claims require rendered evidence. Verify whether capture includes the
pointer before using a screenshot to judge cursor visibility.

## Batch established interactions

Once observation has established a stable layout and event sequence, script the
sequence without requiring model observation between every action. Keep its
preconditions, waits, timeout, and expected end state explicit. Add checkpoints at
uncertain transitions; stop and return evidence when a checkpoint fails. Coordinate
stability must be reestablished after resizing, scrolling, layout changes, or restarts.
For repeated runs, record each iteration's completion and outcome; a final screenshot
alone does not establish how many repetitions succeeded.

For fewer model round trips, one orchestration call can sequentially perform
`actions -> wait -> screenshot -> image read -> return image`. If the harness
cannot return images from that call, use a separate image read; this adds overhead
but does not block computer use. Printing a PNG path or base64 as text does not
give the model an image. Keep dependent steps ordered; parallel capture may precede
the action. Parallelize only independent work with independently owned resources.

## Finish

Verify the requested outcome from the final observed state and relevant evidence.
Report what was actually exercised and any remaining verification gap. Keep useful
reproduction scripts and evidence at known paths. Release held input, close the
owned application, and stop the owned desktop when finished unless continued use
is requested. Identify processes before cleanup; never kill by broad application
name or reset shared services.
