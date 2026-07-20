export const MAX_PAGE_FIELD_BYTES = 2 * 1024;

const MAX_NOTE_BYTES = 4 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;

export function boundValidationNotes(notes: string[]): {
	notes: string[];
	truncated: boolean;
} {
	const bounded: string[] = [];
	let remaining = MAX_NOTE_BYTES;
	let truncated = false;
	for (const note of notes) {
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const result = truncateUtf8(note, remaining);
		bounded.push(result.value);
		remaining -= Buffer.byteLength(result.value, "utf8");
		truncated ||= result.truncated;
	}
	return { notes: bounded, truncated };
}

export function boundValidationResult(result: unknown): {
	result?: unknown;
	resultOmitted?: { reason: "size_limit"; bytes: number };
} {
	if (result === undefined) return {};
	const serialized = JSON.stringify(result);
	const bytes = Buffer.byteLength(serialized, "utf8");
	return bytes <= MAX_RESULT_BYTES
		? { result }
		: { resultOmitted: { reason: "size_limit", bytes } };
}

export function truncateUtf8(
	value: string,
	maxBytes: number,
): { value: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) {
		return { value, truncated: false };
	}
	const suffix = maxBytes >= 3 ? "..." : "";
	let end = value.length;
	while (
		end > 0 &&
		Buffer.byteLength(value.slice(0, end) + suffix, "utf8") > maxBytes
	) {
		end -= 1;
	}
	return { value: value.slice(0, end) + suffix, truncated: true };
}

export function validationErrorMessage(error: unknown): string {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}
