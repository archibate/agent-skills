import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { jobPreview } from "./renderers.ts";

function notificationTitle(header: string): string {
	const match = /^\[(job .*)\](?: (.*))?$/.exec(header);
	if (!match) return header;
	const status = match[2]?.replace(/^finished: /, "");
	return `${match[1]}${status ? ` · ${status}` : ""}`;
}

function notificationBox(content: string, expanded: boolean, outputPad: number, theme: Theme): Box {
	const newline = content.indexOf("\n");
	const header = newline < 0 ? content : content.slice(0, newline);
	const body = newline < 0 ? "" : content.slice(newline + 1);
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	const title = theme.fg("customMessageLabel", theme.bold(notificationTitle(header)));
	box.addChild(expanded ? new Text(title, 0, 0) : {
		render: (width) => [truncateToWidth(title, width)],
		invalidate() {},
	});
	if (body) {
		const styledBody = body.split("\n").map((line) => theme.fg("customMessageText", line)).join("\n");
		if (expanded) {
			box.addChild(new Text(styledBody, 0, 0));
		} else {
			box.addChild(jobPreview(styledBody, theme, "end"));
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
