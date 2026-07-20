/** Extract unique non-clickable ids from visible nodes in serialized DOM snapshot. */
export function extractValidNonClickableIds(dom: string): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];

	const lines = dom.split("\n");
	const hiddenDepthStack: number[] = [];
	const idRegex = /\bncid="([^"]+)"/g;

	for (const line of lines) {
		if (!line.trim()) continue;
		const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
		const depth = Math.floor(leadingSpaces / 2);
		const trimmed = line.trim();

		while (
			hiddenDepthStack.length > 0 &&
			hiddenDepthStack[hiddenDepthStack.length - 1] >= depth
		) {
			hiddenDepthStack.pop();
		}

		if (trimmed === "hidden:") {
			hiddenDepthStack.push(depth);
			continue;
		}
		if (hiddenDepthStack.length > 0) continue;

		let match: RegExpExecArray | null;
		while ((match = idRegex.exec(trimmed)) !== null) {
			const id = match[1]?.trim();
			if (!id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
	}

	return ids;
}
