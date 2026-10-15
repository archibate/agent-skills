const SUMMARY_FORMAT = `Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** The user message appended to the cached conversation to request the summary. */
export function buildInstruction(customInstructions?: string): string {
	const focus = customInstructions?.trim() ? `\n\nAdditional focus: ${customInstructions.trim()}` : "";
	return `[Context compaction] This message comes from the agent harness, not from the user. It is not part of the conversation: leave it out of the summary.

Stop the current task. Do not call tools, do not continue the conversation, and do not answer questions from it. Create a structured context checkpoint summary of the entire conversation above that another LLM will use to continue the work. If the conversation starts with an earlier compaction summary, preserve its information and update it with everything that happened since. Output ONLY the summary.

${SUMMARY_FORMAT}${focus}`;
}

/** Same file lists and format as Pi's default compaction. */
export function fileLists(fileOps: { read: Set<string>; edited: Set<string>; written: Set<string> }) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return { readFiles, modifiedFiles, text: sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "" };
}
