import * as crypto from "crypto";
import yaml from "js-yaml";
import type { PlanStepUpdate, StepResult } from "../agents/types.js";

export const MAX_STEP_RETRIES = 3;
export const STUCK_WINDOW_SIZE = 3;
export const STAGNATION_SAME_ACTION_THRESHOLD = 4;
export const STAGNATION_NO_PROGRESS_THRESHOLD = 5;

export type PlanProgressStatus = "DONE" | "TODO" | "REGRESSED";

const PLAN_LABEL_REGEX = /^\[(DONE|TODO|REGRESSED)\]\s*/;

export type ReplanReason = "model_requested" | "repeated_actions";

export interface StepExecutionSnapshot {
	actionSignature: string;
}

export function hashText(value: string): string {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

export function formatPlanWithStatuses(
	planSteps: string[],
	statuses: PlanProgressStatus[],
): string[] {
	return planSteps.map((step, index) => {
		const status = statuses[index] ?? "TODO";
		const cleanStep = step.replace(PLAN_LABEL_REGEX, "");
		return `[${status}] ${cleanStep}`;
	});
}

export function normalizePlanStepUpdates(
	updates: unknown,
	planLength: number,
): PlanStepUpdate[] {
	if (!Array.isArray(updates)) return [];
	const normalized: PlanStepUpdate[] = [];

	for (const entry of updates) {
		if (!entry || typeof entry !== "object") continue;
		const rawIndex = (entry as { index?: unknown }).index;
		const rawStatus = (entry as { status?: unknown }).status;
		if (!Number.isInteger(rawIndex) || typeof rawStatus !== "string") {
			continue;
		}

		let index = rawIndex as number;
		if (index < 0 || index >= planLength) {
			if (index >= 1 && index <= planLength) {
				index -= 1;
			} else {
				continue;
			}
		}

		const status = rawStatus.trim().toLowerCase();
		if (status !== "done" && status !== "regressed") continue;
		normalized.push({
			index,
			status: status as "done" | "regressed",
		});
	}

	return normalized;
}

export function applyPlanStepUpdates(
	statuses: PlanProgressStatus[],
	updates: PlanStepUpdate[],
): void {
	for (const update of updates) {
		statuses[update.index] =
			update.status === "done" ? "DONE" : "REGRESSED";
	}
}

export function buildActionSignatureWithUrl(
	step: StepResult,
	url: string,
): string {
	const normalizedActions = step.actions.map((action) => {
		const record = action as unknown as Record<string, unknown>;
		const type = typeof record.type === "string" ? record.type : "unknown";
		const bid = typeof record.bid === "string" ? record.bid : "";
		const targetUrl = typeof record.url === "string" ? record.url : "";
		return `${type}:${bid}:${targetUrl}`;
	});
	return `${url}::${yaml.dump(normalizedActions).trim()}`;
}

export function buildProgressSignature(params: {
	url: string;
	dom: string;
	downloadedFiles: string[];
}): string {
	return `${params.url}::${hashText(params.dom)}::${params.downloadedFiles.join("|")}`;
}

export function getReplanReason(params: {
	recentExecutions: StepExecutionSnapshot[];
	actionSignature: string;
	pendingPlanRegeneration: boolean;
}): ReplanReason | null {
	params.recentExecutions.push({ actionSignature: params.actionSignature });
	if (params.recentExecutions.length > STUCK_WINDOW_SIZE) {
		params.recentExecutions.shift();
	}

	if (params.pendingPlanRegeneration) {
		return "model_requested";
	}

	if (params.recentExecutions.length < STUCK_WINDOW_SIZE) {
		return null;
	}

	const firstSignature = params.recentExecutions[0].actionSignature;
	const sameActionRepeated = params.recentExecutions.every(
		(snapshot) => snapshot.actionSignature === firstSignature,
	);
	return sameActionRepeated ? "repeated_actions" : null;
}
