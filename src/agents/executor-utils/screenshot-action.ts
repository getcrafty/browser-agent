import {
	findScreenshotCaptureBids,
	screenshotElementInIsolatedPage,
} from "../../browser/index.js";
import type { Browser } from "../../browser/types.js";
import type {
	ScreenshotToolCapture,
	ScreenshotToolObservation,
} from "../types.js";

interface ScreenshotToolActionResult {
	observation: ScreenshotToolObservation;
	captures: ScreenshotToolCapture[];
}

function splitBidCandidates(rawBid: string): string[] {
	return rawBid
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export function normalizeScreenshotBids(bids: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const rawBid of bids) {
		for (const bid of splitBidCandidates(rawBid)) {
			if (seen.has(bid)) continue;
			seen.add(bid);
			normalized.push(bid);
		}
	}
	return normalized;
}

export async function runScreenshotToolAction(params: {
	browser: Browser;
	bids: string[];
}): Promise<ScreenshotToolActionResult> {
	const requestedBids = normalizeScreenshotBids(params.bids);
	if (requestedBids.length === 0) {
		return {
			observation: {
				requestedBids: [],
				capturedBids: [],
				errors: ["No valid bids were provided to screenshot."],
			},
			captures: [],
		};
	}

	const selectedCaptureBids = await findScreenshotCaptureBids(
		params.browser,
		requestedBids,
	);
	const captured: ScreenshotToolCapture[] = [];
	const errors: string[] = [];

	for (const bid of selectedCaptureBids) {
		try {
			const imageBase64 = await screenshotElementInIsolatedPage(
				params.browser,
				bid,
			);
			captured.push({
				bid,
				imageBase64,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`bid=${bid}: ${message}`);
		}
	}

	if (captured.length === 0 && errors.length === 0) {
		errors.push(
			"No screenshots were captured because no matching elements were found for the requested bids.",
		);
	}

	return {
		observation: {
			requestedBids: selectedCaptureBids,
			capturedBids: captured.map((entry) => entry.bid),
			errors: errors.length > 0 ? errors : undefined,
		},
		captures: captured,
	};
}
