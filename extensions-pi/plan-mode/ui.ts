import { getMarkdownTheme, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { PlanSnapshot } from "./store.ts";

export interface Answer {
	question: string;
	answer: string;
}

export interface ToolDetails {
	status: string;
	message: string;
	planPath?: string;
	snapshot?: PlanSnapshot;
	answers?: Answer[];
	token?: string;
}

export const APPROVAL_CHOICES = ["Execute from checkpoint", "Continue here", "Request changes", "Keep planning"];

export function toolResult(details: ToolDetails, options: { terminate?: boolean; isError?: boolean } = {}, text = details.message): AgentToolResult<ToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...options,
	};
}

export function renderTextResult(result: AgentToolResult<ToolDetails>): Text {
	return new Text(result.details?.message ?? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 0, 0);
}

/** A normal Markdown transcript row, including while the approval selector owns the editor. */
export function renderPlanResult(result: AgentToolResult<ToolDetails>): Container {
	const view = new Container();
	if (result.details?.snapshot) {
		view.addChild(new Markdown(result.details.snapshot.markdown, 0, 1, getMarkdownTheme()));
	}
	view.addChild(renderTextResult(result));
	return view;
}

export async function askQuestions(
	ctx: ExtensionContext,
	questions: { question: string; options?: string[] }[],
	signal: AbortSignal,
): Promise<{ cancelled: boolean; answers: Answer[] }> {
	const answers: Answer[] = [];
	for (const question of questions) {
		if (signal.aborted) return { cancelled: true, answers };
		let answer: string | undefined;
		if (question.options?.length) {
			const options = question.options.map((option, index) => `${index + 1}. ${option}`);
			const other = "Type an answer…";
			const choice = await ctx.ui.select(question.question, [...options, other], { signal });
			if (choice === undefined || signal.aborted) return { cancelled: true, answers };
			if (choice === other) answer = await ctx.ui.input(question.question, "Your answer", { signal });
			else answer = question.options[options.indexOf(choice)];
		} else {
			answer = await ctx.ui.input(question.question, "Your answer", { signal });
		}
		if (answer === undefined || !answer.trim() || signal.aborted) return { cancelled: true, answers };
		answers.push({ question: question.question, answer });
	}
	return { cancelled: false, answers };
}
