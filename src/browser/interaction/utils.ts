import type { Browser } from "../types.js";

type DomNodeTree = {
	nodeId?: number;
	attributes?: string[];
	children?: DomNodeTree[];
	shadowRoots?: DomNodeTree[];
	contentDocument?: DomNodeTree;
};

function getAttributeValue(
	attributes: string[] | undefined,
	name: string,
): string | undefined {
	if (!Array.isArray(attributes)) {
		return undefined;
	}
	for (let i = 0; i < attributes.length; i += 2) {
		if (attributes[i] !== name) {
			continue;
		}
		const value = attributes[i + 1];
		return typeof value === "string" ? value : "";
	}
	return undefined;
}

/** Resolve a bid (browser-use ID stamped on interactive elements) to a DOM nodeId and remoteObjectId. */
export async function resolveElement(
	b: Browser,
	bid: string,
): Promise<{ nodeId: number; objectId: string }> {
	const { root } = await b.DOM.getDocument({ depth: -1, pierce: true });
	const nodesToVisit: DomNodeTree[] = [root as DomNodeTree];

	while (nodesToVisit.length > 0) {
		const currentNode = nodesToVisit.pop();
		if (!currentNode) {
			continue;
		}
		const rawBid = getAttributeValue(currentNode.attributes, "data-bid");
		if (!rawBid) {
			if (currentNode.contentDocument) {
				nodesToVisit.push(currentNode.contentDocument);
			}
			if (Array.isArray(currentNode.shadowRoots)) {
				nodesToVisit.push(...currentNode.shadowRoots);
			}
			if (Array.isArray(currentNode.children)) {
				nodesToVisit.push(...currentNode.children);
			}
			continue;
		}
		const tokens = rawBid
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		if (
			typeof currentNode.nodeId === "number" &&
			(rawBid === bid || tokens.includes(bid))
		) {
			const { object } = await b.DOM.resolveNode({
				nodeId: currentNode.nodeId,
			});
			return {
				nodeId: currentNode.nodeId,
				objectId: object.objectId!,
			};
		}
		if (currentNode.contentDocument) {
			nodesToVisit.push(currentNode.contentDocument);
		}
		if (Array.isArray(currentNode.shadowRoots)) {
			nodesToVisit.push(...currentNode.shadowRoots);
		}
		if (Array.isArray(currentNode.children)) {
			nodesToVisit.push(...currentNode.children);
		}
	}

	throw new Error(`Element not found: bid=${bid}`);
}

export async function checkVisibility(
	b: Browser,
	bid: string,
	objectId: string,
): Promise<void> {
	const { result } = await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return 'zero-size';
      const s = window.getComputedStyle(this);
      if (s.display === 'none') return 'display-none';
      if (s.visibility === 'hidden') return 'visibility-hidden';
      if (s.opacity === '0') return 'opacity-0';
      return '';
    }`,
		returnByValue: true,
	});
	if (result.value) {
		console.log(`    ⚠ bid=${bid} may be invisible (${result.value})`);
	}
}

export function splitBidCandidates(bid: string): string[] {
	return bid
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export function isLikelyNavigationAfterClickError(message: string): boolean {
	return (
		message.includes("Execution context was destroyed") ||
		message.includes("Cannot find context with specified id") ||
		message.includes("Cannot find object with given id") ||
		message.includes("Inspected target navigated or closed")
	);
}

export function isStaleNodeErrorMessage(message: string): boolean {
	return (
		message.includes("Could not find node with given id") ||
		message.includes("Node does not have a layout object") ||
		message.includes("Could not find object with given id")
	);
}

export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
