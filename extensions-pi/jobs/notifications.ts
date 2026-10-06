import { keyText, truncateToVisualLines, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";

function notificationBox(content: string, expanded: boolean, outputPad: number, theme: Theme): Box {
	const newline = content.indexOf("\n");
	const header = newline < 0 ? content : content.slice(0, newline);
	const body = newline < 0 ? "" : content.slice(newline + 1);
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	const title = theme.fg("customMessageLabel", theme.bold(header));
	box.addChild(expanded ? new Text(title, 0, 0) : {
		render: (width) => [truncateToWidth(title, width)],
		invalidate() {},
	});
	if (body) {
		const styledBody = body.split("\n").map((line) => theme.fg("customMessageText", line)).join("\n");
		if (expanded) {
			box.addChild(new Text(styledBody, 0, 0));
		} else {
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;
			box.addChild({
				render(width) {
					if (cachedLines === undefined || cachedWidth !== width) {
						const { visualLines, skippedCount } = truncateToVisualLines(styledBody, 5, width);
						const hint = theme.fg("muted", `... (${skippedCount} earlier lines, `) +
							theme.fg("dim", keyText("app.tools.expand")) + theme.fg("muted", " to expand)");
						cachedLines = skippedCount > 0 ? [truncateToWidth(hint, width), ...visualLines] : visualLines;
						cachedWidth = width;
					}
					return cachedLines;
				},
				invalidate() {
					cachedWidth = undefined;
					cachedLines = undefined;
				},
			});
		}
	}
	return box;
}

/** Per-message click state survives Pi rebuilding custom components on invalidation. */
export function createJobMessageRenderer(): MessageRenderer {
	const states = new WeakMap<object, { expanded: boolean; globalExpanded: boolean }>();
	return (message, { expanded, outputPad }, theme) => {
		let state = states.get(message);
		if (!state) {
			state = { expanded, globalExpanded: expanded };
			states.set(message, state);
		} else if (state.globalExpanded !== expanded) {
			// A changed global keyboard toggle overrides this notification's local click state.
			state.expanded = expanded;
			state.globalExpanded = expanded;
		}
		const viewState = state;
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		let box: Box | undefined;
		let boxExpanded: boolean | undefined;
		const component: Component = {
			render(width) {
				if (!box || boxExpanded !== viewState.expanded) {
					box = notificationBox(content, viewState.expanded, outputPad, theme);
					boxExpanded = viewState.expanded;
				}
				return box.render(width);
			},
			invalidate() {
				box = undefined;
			},
		};
		return new MouseRegion(component, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			viewState.expanded = !viewState.expanded;
			component.invalidate();
			return { handled: true, render: true };
		});
	};
}
