import type { Browser } from "../types.js";
import {
	checkVisibility,
	resolveElement,
	splitBidCandidates,
	toErrorMessage,
} from "./utils.js";

export async function assertPasswordInputBid(
	b: Browser,
	bid: string,
): Promise<void> {
	const candidates = splitBidCandidates(bid);
	const attemptErrors: string[] = [];

	for (const candidateBid of candidates) {
		try {
			const { objectId } = await resolveElement(b, candidateBid);
			await checkVisibility(b, candidateBid, objectId);
			const { result } = await b.Runtime.callFunctionOn({
				objectId,
				functionDeclaration: `function() {
					if (!(this instanceof HTMLInputElement)) {
						return "element is not an HTMLInputElement";
					}
					const inputType = (this.type || "").toLowerCase();
					if (inputType !== "password") {
						return inputType
							? 'input type is "' + inputType + '"'
							: "input type is empty";
					}
					return "";
				}`,
				returnByValue: true,
			});
			if (typeof result.value === "string" && result.value) {
				throw new Error(result.value);
			}
			return;
		} catch (error) {
			attemptErrors.push(`${candidateBid}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate bids provided";
	throw new Error(
		`Failed password input verification for bid=${bid}: ${summary}`,
	);
}

export async function ensureCheckboxChecked(
	b: Browser,
	bid: string,
): Promise<void> {
	const candidates = splitBidCandidates(bid);
	const attemptErrors: string[] = [];

	for (const candidateBid of candidates) {
		try {
			const { objectId } = await resolveElement(b, candidateBid);
			await checkVisibility(b, candidateBid, objectId);
			const { result } = await b.Runtime.callFunctionOn({
				objectId,
				functionDeclaration: `function() {
					const resolveCheckbox = (target) => {
						if (
							target instanceof HTMLInputElement &&
							target.type.toLowerCase() === "checkbox"
						) {
							return target;
						}
						if (target instanceof HTMLLabelElement) {
							if (
								target.control instanceof HTMLInputElement &&
								target.control.type.toLowerCase() === "checkbox"
							) {
								return target.control;
							}
							const nested = target.querySelector(
								'input[type="checkbox"]',
							);
							if (nested instanceof HTMLInputElement) {
								return nested;
							}
						}
						return null;
					};

					const checkbox = resolveCheckbox(this);
					if (!checkbox) {
						return "element is not a checkbox or associated label";
					}
					if (checkbox.disabled) {
						return "checkbox is disabled";
					}
					if (checkbox.checked) {
						return "";
					}
					checkbox.click();
					return checkbox.checked
						? ""
						: "checkbox did not become checked after click";
				}`,
				returnByValue: true,
			});
			if (typeof result.value === "string" && result.value) {
				throw new Error(result.value);
			}
			return;
		} catch (error) {
			attemptErrors.push(`${candidateBid}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate bids provided";
	throw new Error(`Failed checkbox verification for bid=${bid}: ${summary}`);
}

export async function readIdentifierInputByBid(
	b: Browser,
	bid: string,
): Promise<{ value: string; editable: boolean }> {
	const candidates = splitBidCandidates(bid);
	const attemptErrors: string[] = [];

	for (const candidateBid of candidates) {
		try {
			const { objectId } = await resolveElement(b, candidateBid);
			await checkVisibility(b, candidateBid, objectId);
			const { result } = await b.Runtime.callFunctionOn({
				objectId,
				functionDeclaration: `function() {
					const target = this;
					if (
						!(
							target instanceof HTMLInputElement ||
							target instanceof HTMLTextAreaElement
						)
					) {
						return {
							error: "element is not an input or textarea",
						};
					}
					const inputType =
						target instanceof HTMLInputElement
							? (target.type || "").toLowerCase()
							: "textarea";
					if (inputType === "password") {
						return { error: "element is a password input" };
					}
					return {
						value: target.value || "",
						editable: !target.disabled && !target.readOnly,
					};
				}`,
				returnByValue: true,
			});
			const payload = result.value as
				| { value?: unknown; editable?: unknown; error?: unknown }
				| undefined;
			if (payload?.error) {
				throw new Error(String(payload.error));
			}
			return {
				value: typeof payload?.value === "string" ? payload.value : "",
				editable: payload?.editable === true,
			};
		} catch (error) {
			attemptErrors.push(`${candidateBid}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate bids provided";
	throw new Error(`Failed identifier read for bid=${bid}: ${summary}`);
}
