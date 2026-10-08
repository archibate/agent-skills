# Terminal UI and PTY interaction

## Setup

Use an owned PTY or a private tmux server to run the real application interactively.
Follow `$e2e-side-effect-safety` for isolation; with tmux, explicitly pass the
private socket and target pane on every relevant invocation, including cleanup.
A pipe-only run is insufficient when behavior depends on a terminal.

Record the application build, terminal rows/columns, `TERM`, relevant capabilities,
locale/encoding, and emulator or screen-parser identity. Match advertised
capabilities to the harness: do not advertise terminal features it cannot handle.
Use controlled fixtures and set explicit startup, transition, and total deadlines.

Choose evidence before launching:

- For text/cell layout and interaction, capture reconstructed terminal screen state
  using tmux or a terminal-emulation parser that supports the app's output.
- For font rendering, actual colors, glyph appearance, or visual polish, use a
  real terminal emulator and inspect screenshots. Also load [Desktop](desktop.md)
  for a native graphical emulator or [Web](web.md) for a browser-hosted terminal.

## Exercise and capture

1. Start at known rows/columns; wait for an expected ready screen with a deadline.
   Drain PTY output as it arrives so the child cannot block on a full output buffer.
2. Send actual terminal input for navigation, selection, editing, confirmation,
   cancellation, and scrolling as relevant. Distinguish literal text, key sequences,
   and bracketed paste; exercise the input path the scenario claims to test.
3. Wait for the expected resulting screen, not merely a successful input call or
   a fixed sleep. Capture screen cells and relevant attributes/cursor state at
   checkpoints; retain raw output separately for diagnosis.
4. Resize the real PTY/pane and verify the application receives the new dimensions
   and redraws. Include narrow/short and restored sizes relevant to the task;
   changing a parser's dimensions alone does not exercise application resizing.
5. Recheck focus, scrolling, and visible content after transitions and resize.
   Capture intermediate frames when testing flicker or redraw artifacts: a final
   screen cannot establish that the transition was clean.

## Surface checks

- Check wrapping, truncation, borders, alignment, scroll regions, and stale cells
  after shorter content replaces longer content or overlays close.
- Check wide CJK characters, combining characters, and emoji where supported;
  compare expected cell widths with the actual target terminal's behavior.
- Check selection, focus, cursor position/visibility, and supported color/attribute
  states. Inspect screenshots for glyph quality, real contrast, and font fallback.
- Exercise alternate-screen entry/exit where used. On normal exit and relevant
  supported interruption paths, verify restoration of echo/canonical modes,
  cursor visibility, and enabled mouse/paste modes using appropriate terminal
  state queries or a controlled follow-up interaction. A zero exit code alone
  does not establish restoration.

## Evidence boundary and completion

Raw PTY output is an escape-sequence stream, not a screenshot. Matching strings
in it cannot prove final screen layout: text may have been erased or overwritten.
Reconstructed screen state establishes text, cell layout, cursor state, and only
the attributes/sequences the reconstruction supports. Record unsupported features
rather than treating parser limitations as application defects or successful QA.

State-only verification is useful; label it explicitly and leave rendered
appearance unverified. For visual-polish claims, inspect actual terminal-emulator
screenshots of the final build. Screenshots complement PTY tests; they do not
prove unexercised key handling or terminal restoration.

Report tested dimensions, transitions, evidence type, and limitations. On success,
failure, or timeout, close owned PTYs and stop owned processes/sessions; preserve
failure checkpoints and diagnostics. Keep waits and cleanup bounded.
