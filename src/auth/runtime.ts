import { chatYAML, userMessage } from "../agents/providers/router.js";
import yaml from "js-yaml";
import {
	assertPasswordInputBid,
	click,
	ensureCheckboxChecked,
	readIdentifierInputByBid,
	type as typeText,
	waitForAllOpenTabsToSettle,
} from "../browser/index.js";
import type { Browser } from "../browser/types.js";
import type { CoreDeps } from "../core/types.js";
import {
	AUTH_TAKEOVER_FORM_SYSTEM,
	AUTH_TAKEOVER_RESULT_SYSTEM,
} from "./prompt.js";
import type {
	AuthFormProbeDecision,
	AuthProbeAction,
	AuthProbeOutcome,
	AuthSubmitResultDecision,
	AuthTakeoverAttemptTraceEntry,
	AuthTakeoverSelectedBidsPresence,
	SessionAuthTakeoverState,
} from "./types.js";

export class LateWorkflowAuthenticationError extends Error {
	constructor() {
		super(
			"Authentication was requested after the initial workflow-node barrier.",
		);
		this.name = "LateWorkflowAuthenticationError";
	}
}
import type { TokenUsage } from "../agents/types.js";
import { featureFlags } from "../featureFlags.js";

const MAX_AUTH_TAKEOVER_ATTEMPTS = 4;
const AUTH_IDENTIFIER_MATCH_MARKER = "[AUTH_IDENTIFIER_MATCH]";

interface AuthTakeoverRuntimeHooks {
	chatYAML?: typeof chatYAML;
	typeText?: typeof typeText;
	click?: typeof click;
	waitForAllOpenTabsToSettle?: typeof waitForAllOpenTabsToSettle;
	log?: (message: string) => void;
	assertPasswordInputBid?: typeof assertPasswordInputBid;
	ensureCheckboxChecked?: typeof ensureCheckboxChecked;
	readIdentifierInputByBid?: typeof readIdentifierInputByBid;
}

type AuthTakeoverRuntimeResult = {
	handled: boolean;
	traceEntries: AuthTakeoverAttemptTraceEntry[];
};

function sanitizeBid(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function sanitizeReason(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeErrorDetail(error: unknown): string | undefined {
	const raw =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: String(error);
	const sanitized = raw.replace(/\s+/g, " ").trim();
	return sanitized ? sanitized.slice(0, 240) : undefined;
}

function sanitizeAuthProbeAction(value: unknown): AuthProbeAction {
	return value === "submit_credentials" ||
		value === "advance_identifier_step" ||
		value === "select_account" ||
		value === "cannot_attempt"
		? value
		: "cannot_attempt";
}

function sanitizeAuthProbeOutcome(value: unknown): AuthProbeOutcome {
	return value === "invalid_credentials" ||
		value === "success_or_redirect" ||
		value === "requires_user_takeover"
		? value
		: "unknown";
}

function protectBid(
	sessionAuth: SessionAuthTakeoverState,
	bid: string | undefined,
): void {
	if (!bid) {
		return;
	}
	sessionAuth.protectedBids.add(bid);
	sessionAuth.suppressScreenshots = true;
}

function clearAuthProtection(sessionAuth: SessionAuthTakeoverState): void {
	sessionAuth.suppressScreenshots = false;
	sessionAuth.protectedBids.clear();
}

function sanitizeUrlForLog(value: string): string {
	try {
		const url = new URL(value);
		return `${url.origin}${url.pathname}`;
	} catch {
		return value.trim();
	}
}

function emitAuthTakeoverLog(
	hooks: AuthTakeoverRuntimeHooks,
	event: string,
	payload?: Record<string, unknown>,
): void {
	const message =
		payload && Object.keys(payload).length > 0
			? `authTakeover:${event} ${JSON.stringify(payload)}`
			: `authTakeover:${event}`;
	if (hooks.log) {
		hooks.log(message);
		return;
	}
	console.log(`    -> ${message}`);
}

function extractKnownBids(dom: string): Set<string> {
	const bids = new Set<string>();
	for (const match of dom.matchAll(/\bbid="([^"]+)"/g)) {
		const bid = sanitizeBid(match[1]);
		if (bid) {
			bids.add(bid);
		}
	}
	return bids;
}

function buildSelectedBidsPresence(
	dom: string,
	decision: AuthFormProbeDecision,
): AuthTakeoverSelectedBidsPresence {
	const knownBids = extractKnownBids(dom);
	const hasBid = (bid: string | undefined): boolean =>
		Boolean(bid && knownBids.has(bid));
	return {
		username: hasBid(decision.usernameBid),
		password: hasBid(decision.passwordBid),
		submit: hasBid(decision.submitBid),
		continue: hasBid(decision.continueBid),
		stayLoggedInCheckbox: hasBid(decision.stayLoggedInCheckboxBid),
		switchIdentifier: hasBid(decision.switchIdentifierBid),
		account: hasBid(decision.accountBid),
	};
}

function buildSafePromptExcerpt(dom: string): string | undefined {
	const excerpt = dom
		.split("\n")
		.map((line) =>
			line
				.trim()
				.replace(/\bbid="[^"]+"/g, 'bid="[REDACTED]"')
				.replace(/"[^"]*"/g, '"[REDACTED]"')
				.replace(/:\s*.+$/, ": [REDACTED]"),
		)
		.filter((line) => line.length > 0)
		.slice(0, 3)
		.join(" | ");
	return excerpt.length > 0 ? excerpt.slice(0, 240) : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactAuthIdentifierValuesFromDom(
	dom: string,
	authIdentifier?: string,
): string {
	const redactedDom = dom
		.split("\n")
		.map((line) => {
			if (
				!/^\s*input\b/i.test(line) ||
				!(
					/\btype="email"/i.test(line) ||
					/\bautocomplete="username"/i.test(line) ||
					/\bname="(?:email|username|login|identifier)"/i.test(line)
				)
			) {
				return line;
			}
			return line
				.replace(/\bvalue="[^"]*"/g, 'value="[REDACTED]"')
				.replace(/:\s*"[^"]*"(\s*)$/, ': "[REDACTED]"$1');
		})
		.join("\n");
	const trimmedIdentifier = authIdentifier?.trim();
	if (!trimmedIdentifier) {
		return redactedDom;
	}
	return redactedDom.replace(
		new RegExp(escapeRegExp(trimmedIdentifier), "gi"),
		AUTH_IDENTIFIER_MATCH_MARKER,
	);
}

function emitAttemptTrace(
	hooks: AuthTakeoverRuntimeHooks,
	trace: AuthTakeoverAttemptTraceEntry,
): void {
	emitAuthTakeoverLog(hooks, "attempt_trace", { ...trace });
}

function getProbePromptMessages(dom: string) {
	return [
		{ role: "system" as const, content: AUTH_TAKEOVER_FORM_SYSTEM },
		userMessage(dom),
	];
}

function getResultPromptMessages(dom: string) {
	return [
		{ role: "system" as const, content: AUTH_TAKEOVER_RESULT_SYSTEM },
		userMessage(dom),
	];
}

function serializePromptMessages(
	messages: ReturnType<typeof getProbePromptMessages>,
): unknown[] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
	}));
}

function buildAssistantYamlMessage(params: {
	content: Record<string, unknown>;
	reasoningTokens?: string;
}): {
	role: "assistant";
	content: string;
	reasoning_tokens?: string;
} {
	return {
		role: "assistant",
		content: yaml.dump(params.content),
		...(typeof params.reasoningTokens === "string"
			? { reasoning_tokens: params.reasoningTokens }
			: {}),
	};
}

function buildProbeAttemptMessages(params: {
	dom: string;
	decision: AuthFormProbeDecision;
	reasoningTokens?: string;
}): unknown[] {
	const promptMessages = getProbePromptMessages(params.dom);
	const assistantPayload: Record<string, unknown> = {
		action: sanitizeAuthProbeAction(params.decision.action),
	};
	if (params.decision.usernameBid) {
		assistantPayload.usernameBid = params.decision.usernameBid;
	}
	if (params.decision.passwordBid) {
		assistantPayload.passwordBid = params.decision.passwordBid;
	}
	if (params.decision.submitBid) {
		assistantPayload.submitBid = params.decision.submitBid;
	}
	if (params.decision.continueBid) {
		assistantPayload.continueBid = params.decision.continueBid;
	}
	if (params.decision.stayLoggedInCheckboxBid) {
		assistantPayload.stayLoggedInCheckboxBid =
			params.decision.stayLoggedInCheckboxBid;
	}
	if (params.decision.switchIdentifierBid) {
		assistantPayload.switchIdentifierBid =
			params.decision.switchIdentifierBid;
	}
	if (params.decision.accountBid) {
		assistantPayload.accountBid = params.decision.accountBid;
	}
	if (params.decision.reason) {
		assistantPayload.reason = params.decision.reason;
	}
	return [
		...serializePromptMessages(promptMessages),
		buildAssistantYamlMessage({
			content: assistantPayload,
			reasoningTokens: params.reasoningTokens,
		}),
	];
}

function buildResultAttemptMessages(params: {
	dom: string;
	result: AuthSubmitResultDecision;
	reasoningTokens?: string;
}): unknown[] {
	const promptMessages = getResultPromptMessages(params.dom);
	const assistantPayload: Record<string, unknown> = {
		outcome: sanitizeAuthProbeOutcome(params.result.outcome),
	};
	if (params.result.reason) {
		assistantPayload.reason = params.result.reason;
	}
	return [
		...serializePromptMessages(promptMessages),
		buildAssistantYamlMessage({
			content: assistantPayload,
			reasoningTokens: params.reasoningTokens,
		}),
	];
}

async function buildRedactedDom(params: {
	deps: Pick<CoreDeps, "getSimplifiedDOM">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState;
	authIdentifier?: string;
}): Promise<string> {
	const dom = await params.deps.getSimplifiedDOM(params.browser, {
		...(featureFlags.removeHrefsFromInputContext
			? { omitHrefs: true }
			: {}),
		redactInputBids: [...params.sessionAuth.protectedBids],
		redactPasswordInputs: true,
	});
	return redactAuthIdentifierValuesFromDom(dom, params.authIdentifier);
}

async function probeAuthForm(params: {
	deps: Pick<CoreDeps, "getSimplifiedDOM">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState;
	hooks: AuthTakeoverRuntimeHooks;
	caller: string;
	currentUrl: string;
	dom?: string;
}): Promise<{
	dom: string;
	decision: AuthFormProbeDecision;
	authUsernameOrEmail?: string;
	usage?: TokenUsage;
	reasoning_tokens?: string;
}> {
	const authUsernameOrEmail = await requestIdentifierForUrl(
		params.sessionAuth,
		params.currentUrl,
	);
	const dom =
		params.dom ??
		(await buildRedactedDom({
			...params,
			authIdentifier: authUsernameOrEmail,
		}));
	const chatYAMLImpl = params.hooks.chatYAML ?? chatYAML;
	if (!params.sessionAuth.authProbeLLM) {
		return {
			dom,
			authUsernameOrEmail,
			decision: {
				action: "cannot_attempt",
				reason: "model_probe_unavailable",
			},
		};
	}
	let decision: AuthFormProbeDecision;
	try {
		const { data, usage, reasoning_tokens } =
			await chatYAMLImpl<AuthFormProbeDecision>(
				getProbePromptMessages(dom),
				params.sessionAuth.authProbeLLM,
				params.caller,
			);
		decision = {
			action: sanitizeAuthProbeAction(data.action),
			usernameBid: sanitizeBid(data.usernameBid),
			passwordBid: sanitizeBid(data.passwordBid),
			submitBid: sanitizeBid(data.submitBid),
			continueBid: sanitizeBid(data.continueBid),
			stayLoggedInCheckboxBid: sanitizeBid(data.stayLoggedInCheckboxBid),
			switchIdentifierBid: sanitizeBid(data.switchIdentifierBid),
			accountBid: sanitizeBid(data.accountBid),
			reason: sanitizeReason(data.reason),
		};
		return { dom, decision, authUsernameOrEmail, usage, reasoning_tokens };
	} catch {
		decision = {
			action: "cannot_attempt",
			reason: "model_probe_failed",
		};
	}
	return { dom, decision, authUsernameOrEmail };
}

async function classifySubmitResult(params: {
	deps: Pick<CoreDeps, "getSimplifiedDOM">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState;
	hooks: AuthTakeoverRuntimeHooks;
	caller: string;
	currentUrl: string;
}): Promise<{
	dom: string;
	result: AuthSubmitResultDecision;
	usage?: TokenUsage;
	reasoning_tokens?: string;
}> {
	const authUsernameOrEmail = await requestIdentifierForUrl(
		params.sessionAuth,
		params.currentUrl,
	);
	const dom = await buildRedactedDom({
		...params,
		authIdentifier: authUsernameOrEmail,
	});
	const chatYAMLImpl = params.hooks.chatYAML ?? chatYAML;
	try {
		const { data, usage, reasoning_tokens } =
			await chatYAMLImpl<AuthSubmitResultDecision>(
				getResultPromptMessages(dom),
				params.sessionAuth.authProbeLLM!,
				params.caller,
			);
		return {
			dom,
			result: {
				outcome: sanitizeAuthProbeOutcome(data.outcome),
				reason: sanitizeReason(data.reason),
			},
			usage,
			reasoning_tokens,
		};
	} catch {
		return {
			dom,
			result: {
				outcome: "unknown",
				reason: "model_result_failed",
			},
			usage: undefined,
			reasoning_tokens: undefined,
		};
	}
}

async function advanceIdentifierStep(params: {
	browser: Browser;
	usernameBid: string;
	continueBid?: string;
	identifier: string;
	enterFallback: boolean;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<void> {
	const typeTextImpl = params.hooks.typeText ?? typeText;
	const clickImpl = params.hooks.click ?? click;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await typeTextImpl(
		params.browser,
		params.usernameBid,
		params.identifier,
		params.enterFallback,
	);
	if (params.continueBid) {
		await clickImpl(params.browser, params.continueBid);
	}
	await waitForAllOpenTabsToSettleImpl(params.browser);
}

async function submitCredentialAttempt(params: {
	browser: Browser;
	passwordBid: string;
	submitBid: string;
	stayLoggedInCheckboxBid?: string;
	password: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<void> {
	const typeTextImpl = params.hooks.typeText ?? typeText;
	const clickImpl = params.hooks.click ?? click;
	const ensureCheckboxCheckedImpl =
		params.hooks.ensureCheckboxChecked ?? ensureCheckboxChecked;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await typeTextImpl(params.browser, params.passwordBid, params.password);
	const stayBid = sanitizeBid(params.stayLoggedInCheckboxBid);
	if (stayBid) {
		await ensureCheckboxCheckedImpl(params.browser, stayBid);
	}
	await clickImpl(params.browser, params.submitBid);
	await waitForAllOpenTabsToSettleImpl(params.browser);
}

function looksLikeEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function identifiersMatch(actual: string, expected: string): boolean {
	const trimmedActual = actual.trim();
	const trimmedExpected = expected.trim();
	if (looksLikeEmail(trimmedActual) && looksLikeEmail(trimmedExpected)) {
		return trimmedActual.toLowerCase() === trimmedExpected.toLowerCase();
	}
	return trimmedActual === trimmedExpected;
}

function domTextMatchesIdentifier(text: string, identifier: string): boolean {
	const trimmedText = text.trim();
	const trimmedIdentifier = identifier.trim();
	if (!trimmedText || !trimmedIdentifier) {
		return false;
	}
	if (identifiersMatch(trimmedText, trimmedIdentifier)) {
		return true;
	}
	if (looksLikeEmail(trimmedIdentifier)) {
		return trimmedText
			.toLowerCase()
			.includes(trimmedIdentifier.toLowerCase());
	}
	return false;
}

function domContainsIdentifierText(dom: string, identifier: string): boolean {
	if (dom.includes(AUTH_IDENTIFIER_MATCH_MARKER)) {
		return true;
	}
	for (const match of dom.matchAll(/"([^"]*)"/g)) {
		if (domTextMatchesIdentifier(match[1] ?? "", identifier)) {
			return true;
		}
	}
	return false;
}

async function reconcileVisibleIdentifier(params: {
	browser: Browser;
	usernameBid: string;
	identifier: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<"matched" | "replaced" | "mismatch_not_editable"> {
	const readIdentifierInputByBidImpl =
		params.hooks.readIdentifierInputByBid ?? readIdentifierInputByBid;
	const typeTextImpl = params.hooks.typeText ?? typeText;
	const current = await readIdentifierInputByBidImpl(
		params.browser,
		params.usernameBid,
	);
	if (identifiersMatch(current.value, params.identifier)) {
		return "matched";
	}
	if (!current.editable) {
		return "mismatch_not_editable";
	}
	await typeTextImpl(params.browser, params.usernameBid, params.identifier);
	const updated = await readIdentifierInputByBidImpl(
		params.browser,
		params.usernameBid,
	);
	return identifiersMatch(updated.value, params.identifier)
		? "replaced"
		: "mismatch_not_editable";
}

async function switchIdentifier(params: {
	browser: Browser;
	switchIdentifierBid: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<void> {
	const clickImpl = params.hooks.click ?? click;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await clickImpl(params.browser, params.switchIdentifierBid);
	await waitForAllOpenTabsToSettleImpl(params.browser);
}

async function selectAccountOrIdentifierSwitch(params: {
	browser: Browser;
	accountBid?: string;
	switchIdentifierBid?: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<"account_selected" | "identifier_switch_clicked"> {
	const clickBid = params.accountBid ?? params.switchIdentifierBid;
	if (!clickBid) {
		throw new Error("missing account chooser bid");
	}
	const clickImpl = params.hooks.click ?? click;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await clickImpl(params.browser, clickBid);
	await waitForAllOpenTabsToSettleImpl(params.browser);
	return params.accountBid ? "account_selected" : "identifier_switch_clicked";
}

async function hasDomainCandidate(
	sessionAuth: SessionAuthTakeoverState,
	currentUrl: string,
): Promise<{ matched: boolean; error?: string }> {
	if (!sessionAuth.requestAuthDomainCandidates) {
		return { matched: false };
	}
	try {
		const matches = await sessionAuth.requestAuthDomainCandidates(
			currentUrl,
			{
				purpose: "auth_takeover",
			},
		);
		return { matched: matches.length > 0 };
	} catch {
		return {
			matched: false,
			error: "lookup_failed",
		};
	}
}

async function requestIdentifierForUrl(
	sessionAuth: SessionAuthTakeoverState,
	currentUrl: string,
): Promise<string | undefined> {
	if (!sessionAuth.requestAuthIdentifierForDomain) {
		return undefined;
	}
	try {
		const identifier = await sessionAuth.requestAuthIdentifierForDomain(
			currentUrl,
			{
				purpose: "auth_takeover",
			},
		);
		return typeof identifier === "string" && identifier.length > 0
			? identifier
			: undefined;
	} catch {
		return undefined;
	}
}

async function requestPasswordForUrl(
	sessionAuth: SessionAuthTakeoverState,
	currentUrl: string,
): Promise<string | undefined> {
	if (!sessionAuth.requestAuthPasswordForDomain) {
		return undefined;
	}
	try {
		const password = await sessionAuth.requestAuthPasswordForDomain(
			currentUrl,
			{
				purpose: "auth_takeover",
			},
		);
		return typeof password === "string" && password.length > 0
			? password
			: undefined;
	} catch {
		return undefined;
	}
}

function validateRequiredDecisionBids(params: {
	decision: AuthFormProbeDecision;
	selectedBidsPresent: AuthTakeoverSelectedBidsPresence;
}): string | undefined {
	if (params.decision.action === "cannot_attempt") {
		return undefined;
	}
	if (params.decision.usernameBid && !params.selectedBidsPresent.username) {
		return "username_bid_not_present";
	}
	if (params.decision.passwordBid && !params.selectedBidsPresent.password) {
		return "password_bid_not_present";
	}
	if (params.decision.submitBid && !params.selectedBidsPresent.submit) {
		return "submit_bid_not_present";
	}
	if (params.decision.continueBid && !params.selectedBidsPresent.continue) {
		return "continue_bid_not_present";
	}
	if (
		params.decision.stayLoggedInCheckboxBid &&
		!params.selectedBidsPresent.stayLoggedInCheckbox
	) {
		return "stay_logged_in_checkbox_not_present";
	}
	if (
		params.decision.switchIdentifierBid &&
		!params.selectedBidsPresent.switchIdentifier
	) {
		return "switch_identifier_bid_not_present";
	}
	if (params.decision.accountBid && !params.selectedBidsPresent.account) {
		return "account_bid_not_present";
	}
	if (
		params.decision.action === "advance_identifier_step" &&
		!params.decision.usernameBid
	) {
		return "missing_identifier_bids";
	}
	if (
		params.decision.action === "select_account" &&
		!params.decision.accountBid &&
		!params.decision.switchIdentifierBid
	) {
		return "missing_select_account_bids";
	}
	if (
		params.decision.action === "submit_credentials" &&
		(!params.decision.passwordBid || !params.decision.submitBid)
	) {
		return "missing_submit_bids";
	}
	if (
		params.decision.action === "advance_identifier_step" &&
		!params.selectedBidsPresent.username
	) {
		return "identifier_bids_not_present";
	}
	if (
		params.decision.action === "submit_credentials" &&
		(!params.selectedBidsPresent.password ||
			!params.selectedBidsPresent.submit)
	) {
		return "submit_bids_not_present";
	}
	return undefined;
}

export async function attemptAutomatedAuthTakeover(params: {
	deps: Pick<CoreDeps, "getSimplifiedDOM" | "getCurrentURL">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState | undefined;
	stepBaseIndex?: number;
	hooks?: AuthTakeoverRuntimeHooks;
}): Promise<AuthTakeoverRuntimeResult> {
	const sessionAuth = params.sessionAuth;
	const hooks = params.hooks ?? {};
	const traceEntries: AuthTakeoverAttemptTraceEntry[] = [];
	let identifierConfirmed = false;
	const getNextAuthStepNumber = (): number | undefined =>
		typeof params.stepBaseIndex === "number"
			? params.stepBaseIndex + traceEntries.length + 1
			: undefined;

	function returnUnhandled(
		reason: string,
		payload?: Record<string, unknown>,
	): AuthTakeoverRuntimeResult {
		emitAuthTakeoverLog(hooks, "returning_unhandled", {
			reason,
			...(payload ?? {}),
		});
		return { handled: false, traceEntries };
	}

	if (
		!sessionAuth?.enabled ||
		!sessionAuth.requestAuthDomainCandidates ||
		!sessionAuth.requestAuthIdentifierForDomain ||
		!sessionAuth.requestAuthPasswordForDomain
	) {
		emitAuthTakeoverLog(hooks, "skipped_preconditions", {
			enabled: sessionAuth?.enabled ?? false,
			hasAuthProbeLLM: Boolean(sessionAuth?.authProbeLLM),
			hasDomainCandidateCallback: Boolean(
				sessionAuth?.requestAuthDomainCandidates,
			),
			hasIdentifierLookupCallback: Boolean(
				sessionAuth?.requestAuthIdentifierForDomain,
			),
			hasPasswordLookupCallback: Boolean(
				sessionAuth?.requestAuthPasswordForDomain,
			),
		});
		return returnUnhandled("preconditions");
	}

	const currentUrl = await params.deps.getCurrentURL(params.browser);
	const initialCandidateCheck = await hasDomainCandidate(
		sessionAuth,
		currentUrl,
	);
	emitAuthTakeoverLog(hooks, "domain_candidate_check", {
		stage: "initial",
		currentUrl: sanitizeUrlForLog(currentUrl),
		matched: initialCandidateCheck.matched,
		...(initialCandidateCheck.error
			? { error: initialCandidateCheck.error }
			: {}),
	});
	if (!initialCandidateCheck.matched) {
		return returnUnhandled("no_domain_candidate_initial");
	}

	for (
		let authAttempt = 0;
		authAttempt < MAX_AUTH_TAKEOVER_ATTEMPTS;
		authAttempt += 1
	) {
		const probeStepNumber = getNextAuthStepNumber();
		emitAuthTakeoverLog(hooks, "attempt_started", {
			attempt: authAttempt + 1,
			...(typeof probeStepNumber === "number"
				? { step: probeStepNumber }
				: {}),
			maxAttempts: MAX_AUTH_TAKEOVER_ATTEMPTS,
		});
		const authUrl = await params.deps.getCurrentURL(params.browser);
		const stepCandidateCheck = await hasDomainCandidate(
			sessionAuth,
			authUrl,
		);
		emitAuthTakeoverLog(hooks, "domain_candidate_check", {
			stage: "attempt",
			attempt: authAttempt + 1,
			...(typeof probeStepNumber === "number"
				? { step: probeStepNumber }
				: {}),
			currentUrl: sanitizeUrlForLog(authUrl),
			matched: stepCandidateCheck.matched,
			...(stepCandidateCheck.error
				? { error: stepCandidateCheck.error }
				: {}),
		});

		if (!stepCandidateCheck.matched) {
			return returnUnhandled("no_domain_candidate_attempt", {
				attempt: authAttempt + 1,
			});
		}

		const {
			dom,
			decision,
			authUsernameOrEmail,
			usage: probeUsage,
			reasoning_tokens: probeReasoningTokens,
		} = await probeAuthForm({
			deps: params.deps,
			browser: params.browser,
			sessionAuth,
			hooks,
			caller:
				typeof probeStepNumber === "number"
					? `authTakeover:probe:step${probeStepNumber}`
					: "authTakeover:probe",
			currentUrl: authUrl,
		});
		const selectedBidsPresent = buildSelectedBidsPresence(dom, decision);
		emitAuthTakeoverLog(hooks, "auth_fields_detected", {
			attempt: authAttempt + 1,
			...(typeof probeStepNumber === "number"
				? { step: probeStepNumber }
				: {}),
			hasUsernameBid: selectedBidsPresent.username,
			hasPasswordBid: selectedBidsPresent.password,
			hasSubmitBid: selectedBidsPresent.submit,
			hasContinueBid: selectedBidsPresent.continue,
			hasStayLoggedInCheckboxBid:
				selectedBidsPresent.stayLoggedInCheckbox,
			hasSwitchIdentifierBid:
				selectedBidsPresent.switchIdentifier === true,
			hasAccountBid: selectedBidsPresent.account === true,
		});
		const selectedBidFailure = validateRequiredDecisionBids({
			decision,
			selectedBidsPresent,
		});
		const probeTrace: AuthTakeoverAttemptTraceEntry = {
			...(typeof probeStepNumber === "number"
				? { step: probeStepNumber }
				: {}),
			attempt: authAttempt + 1,
			stage: "probe",
			decisionAction: sanitizeAuthProbeAction(decision.action),
			selectedBidsPresent,
			decisionReason: sanitizeReason(decision.reason),
			messages: buildProbeAttemptMessages({
				dom,
				decision,
				reasoningTokens: probeReasoningTokens,
			}),
			token_usage: probeUsage,
			outcome:
				selectedBidFailure || decision.action === "cannot_attempt"
					? "cannot_attempt"
					: "unhandled",
			outcomeReason:
				selectedBidFailure ||
				sanitizeReason(decision.reason) ||
				"model_declined",
			redactedPromptExcerpt: buildSafePromptExcerpt(dom),
		};
		if (selectedBidFailure || decision.action === "cannot_attempt") {
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			if (decision.reason === "model_probe_unavailable") {
				continue;
			}
			return returnUnhandled(selectedBidFailure ?? "cannot_attempt", {
				attempt: authAttempt + 1,
				action: decision.action,
			});
		}

		if (decision.action === "select_account") {
			try {
				const outcome = await selectAccountOrIdentifierSwitch({
					browser: params.browser,
					accountBid: decision.accountBid,
					switchIdentifierBid: decision.switchIdentifierBid,
					hooks,
				});
				emitAuthTakeoverLog(hooks, outcome, {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
				});
				probeTrace.outcome = "advanced_identifier_step";
				probeTrace.outcomeReason = outcome;
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				identifierConfirmed = outcome === "account_selected";
				continue;
			} catch {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "account_select_failed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("account_select_failed", {
					attempt: authAttempt + 1,
				});
			}
		}

		if (decision.action === "advance_identifier_step") {
			const identifier = await requestIdentifierForUrl(
				sessionAuth,
				authUrl,
			);
			if (!identifier) {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "identifier_lookup_missed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_lookup_missed", {
					attempt: authAttempt + 1,
				});
			}
			protectBid(sessionAuth, decision.usernameBid);
			try {
				const usedEnterFallback = !decision.continueBid;
				await advanceIdentifierStep({
					browser: params.browser,
					usernameBid: decision.usernameBid!,
					continueBid: decision.continueBid,
					identifier,
					enterFallback: usedEnterFallback,
					hooks,
				});
				emitAuthTakeoverLog(hooks, "identifier_step_completed", {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
					usedContinueBid: Boolean(decision.continueBid),
					usedEnterFallback,
				});
				identifierConfirmed = true;
				probeTrace.outcome = "advanced_identifier_step";
				probeTrace.outcomeReason = "identifier_step_completed";
			} catch (error) {
				const errorDetail = sanitizeErrorDetail(error);
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = errorDetail
					? `identifier_step_failed: ${errorDetail}`
					: "identifier_step_failed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_step_failed", {
					attempt: authAttempt + 1,
					...(errorDetail ? { error: errorDetail } : {}),
				});
			}
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			continue;
		}

		if (decision.action !== "submit_credentials") {
			probeTrace.outcome = "cannot_attempt";
			probeTrace.outcomeReason = "model_declined";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("form_probe_declined", {
				attempt: authAttempt + 1,
				action: decision.action,
			});
		}

		const identifier =
			decision.usernameBid || !identifierConfirmed
				? await requestIdentifierForUrl(sessionAuth, authUrl)
				: undefined;
		if ((decision.usernameBid || !identifierConfirmed) && !identifier) {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "identifier_lookup_missed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("identifier_lookup_missed", {
				attempt: authAttempt + 1,
			});
		}
		let credentialSubmitOutcomeReason: string | undefined;
		if (decision.usernameBid) {
			protectBid(sessionAuth, decision.usernameBid);
			try {
				const reconcileResult = await reconcileVisibleIdentifier({
					browser: params.browser,
					usernameBid: decision.usernameBid,
					identifier: identifier!,
					hooks,
				});
				if (reconcileResult === "mismatch_not_editable") {
					if (decision.switchIdentifierBid) {
						await switchIdentifier({
							browser: params.browser,
							switchIdentifierBid: decision.switchIdentifierBid,
							hooks,
						});
						emitAuthTakeoverLog(
							hooks,
							"identifier_switch_clicked",
							{
								attempt: authAttempt + 1,
								...(typeof probeStepNumber === "number"
									? { step: probeStepNumber }
									: {}),
							},
						);
						probeTrace.outcome = "advanced_identifier_step";
						probeTrace.outcomeReason = "identifier_switch_clicked";
						traceEntries.push(probeTrace);
						emitAttemptTrace(hooks, probeTrace);
						identifierConfirmed = false;
						continue;
					}
					probeTrace.outcome = "unhandled";
					probeTrace.outcomeReason = "identifier_mismatch";
					traceEntries.push(probeTrace);
					emitAttemptTrace(hooks, probeTrace);
					return returnUnhandled("identifier_mismatch", {
						attempt: authAttempt + 1,
					});
				}
				identifierConfirmed = true;
				credentialSubmitOutcomeReason =
					reconcileResult === "matched"
						? "identifier_already_matched"
						: "identifier_replaced";
			} catch {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "identifier_read_failed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_read_failed", {
					attempt: authAttempt + 1,
				});
			}
		} else if (!identifierConfirmed) {
			if (identifier && domContainsIdentifierText(dom, identifier)) {
				identifierConfirmed = true;
				credentialSubmitOutcomeReason = "identifier_text_matched";
				emitAuthTakeoverLog(hooks, "identifier_text_matched", {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
				});
			} else if (decision.switchIdentifierBid) {
				try {
					await switchIdentifier({
						browser: params.browser,
						switchIdentifierBid: decision.switchIdentifierBid,
						hooks,
					});
				} catch {
					probeTrace.outcome = "unhandled";
					probeTrace.outcomeReason = "identifier_switch_failed";
					traceEntries.push(probeTrace);
					emitAttemptTrace(hooks, probeTrace);
					return returnUnhandled("identifier_switch_failed", {
						attempt: authAttempt + 1,
					});
				}
				emitAuthTakeoverLog(hooks, "identifier_switch_clicked", {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
				});
				probeTrace.outcome = "advanced_identifier_step";
				probeTrace.outcomeReason = "identifier_switch_clicked";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				continue;
			} else {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "identifier_not_verifiable";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_not_verifiable", {
					attempt: authAttempt + 1,
				});
			}
		}

		protectBid(sessionAuth, decision.passwordBid);
		const assertPasswordInputBidImpl =
			hooks.assertPasswordInputBid ?? assertPasswordInputBid;
		try {
			await assertPasswordInputBidImpl(
				params.browser,
				decision.passwordBid!,
			);
		} catch {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "password_bid_verification_failed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("password_bid_verification_failed", {
				attempt: authAttempt + 1,
			});
		}

		const password = await requestPasswordForUrl(sessionAuth, authUrl);
		if (!password) {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "password_lookup_missed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("password_lookup_missed", {
				attempt: authAttempt + 1,
			});
		}

		try {
			await submitCredentialAttempt({
				browser: params.browser,
				passwordBid: decision.passwordBid!,
				submitBid: decision.submitBid!,
				stayLoggedInCheckboxBid: decision.stayLoggedInCheckboxBid,
				password,
				hooks,
			});
		} catch {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "credential_submit_failed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("credential_submit_failed", {
				attempt: authAttempt + 1,
			});
		}
		probeTrace.outcome = "submitted_credentials";
		probeTrace.outcomeReason = credentialSubmitOutcomeReason
			? `${credentialSubmitOutcomeReason}; credentials_submitted`
			: "credentials_submitted";
		traceEntries.push(probeTrace);
		emitAttemptTrace(hooks, probeTrace);

		const resultStepNumber = getNextAuthStepNumber();
		const submitResult = await classifySubmitResult({
			deps: params.deps,
			browser: params.browser,
			sessionAuth,
			hooks,
			currentUrl: authUrl,
			caller:
				typeof resultStepNumber === "number"
					? `authTakeover:result:step${resultStepNumber}`
					: "authTakeover:result",
		});
		const resultTrace: AuthTakeoverAttemptTraceEntry = {
			...(typeof resultStepNumber === "number"
				? { step: resultStepNumber }
				: {}),
			attempt: authAttempt + 1,
			stage: "result",
			decisionAction: sanitizeAuthProbeAction(decision.action),
			selectedBidsPresent,
			decisionReason: sanitizeReason(decision.reason),
			messages: buildResultAttemptMessages({
				dom: submitResult.dom,
				result: submitResult.result,
				reasoningTokens: submitResult.reasoning_tokens,
			}),
			token_usage: submitResult.usage,
			outcome: submitResult.result.outcome,
			outcomeReason: submitResult.result.reason ?? undefined,
			redactedPromptExcerpt: buildSafePromptExcerpt(submitResult.dom),
		};
		traceEntries.push(resultTrace);
		emitAttemptTrace(hooks, resultTrace);

		if (resultTrace.outcome !== "success_or_redirect") {
			return returnUnhandled("real_result_not_success_or_redirect", {
				attempt: authAttempt + 1,
				outcome: resultTrace.outcome,
			});
		}

		clearAuthProtection(sessionAuth);
		return { handled: true, traceEntries };
	}

	emitAuthTakeoverLog(hooks, "attempt_budget_exhausted", {
		maxAttempts: MAX_AUTH_TAKEOVER_ATTEMPTS,
	});
	return returnUnhandled("attempt_budget_exhausted", {
		maxAttempts: MAX_AUTH_TAKEOVER_ATTEMPTS,
	});
}
