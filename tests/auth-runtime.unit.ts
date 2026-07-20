import { assert } from "chai";
import { describe, it } from "mocha";
import { attemptAutomatedAuthTakeover } from "../src/auth/runtime.js";
import {
	createAuthCredentialCallbacksFromInput,
	createSessionAuthTakeoverState,
} from "../src/auth/crypto.js";
import type {
	AuthCredentialsInput,
	AuthLookupOptions,
} from "../src/auth/types.js";
import type { SessionAuthTakeoverState } from "../src/auth/types.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";
import { assertNoSecretLeaksInText } from "./helpers/auth-prompt-capture.js";

function createAuthSession(input: {
	enabled: boolean;
	credentials?: AuthCredentialsInput;
}) {
	const callbacks = createAuthCredentialCallbacksFromInput({
		credentials: input.credentials,
	});
	return createSessionAuthTakeoverState({
		enabled: input.enabled,
		requestAuthDomainCandidates: callbacks?.requestAuthDomainCandidates,
		requestAuthIdentifierForDomain:
			callbacks?.requestAuthIdentifierForDomain,
		requestAuthPasswordForDomain: callbacks?.requestAuthPasswordForDomain,
	});
}

function extractBid(dom: string, pattern: RegExp): string | undefined {
	return dom.match(pattern)?.[1];
}

function extractIdentifierBid(dom: string): string | undefined {
	return (
		extractBid(dom, /input bid="([^"]+)"[^\n]*type="email"/i) ??
		extractBid(dom, /input bid="([^"]+)"[^\n]*autocomplete="username"/i) ??
		extractBid(dom, /input bid="([^"]+)"[^\n]*placeholder="Email"/i) ??
		extractBid(dom, /input bid="([^"]+)"[^\n]*name="email"/i)
	);
}

function extractCheckboxBid(dom: string): string | undefined {
	return extractBid(dom, /input bid="([^"]+)"[^\n]*type="checkbox"/i);
}

function extractSwitchIdentifierBid(dom: string): string | undefined {
	for (const block of dom.split(
		/\n(?=\s*(?:bid="[^"]+"\s+(?:button|link):|(?:button|link)\s+bid="[^"]+"))/,
	)) {
		const bid = firstDefined(
			block.match(/^\s*bid="([^"]+)"\s+(?:button|link):/m)?.[1],
			block.match(/^\s*(?:button|link)\s+bid="([^"]+)"/m)?.[1],
		);
		if (bid && /Use another|different|Change|Add account/i.test(block)) {
			return bid;
		}
	}
	return undefined;
}

function firstDefined(
	...values: Array<string | undefined>
): string | undefined {
	return values.find((value): value is string => typeof value === "string");
}

function extractAccountBid(dom: string): string | undefined {
	for (const block of dom.split(
		/\n(?=\s*(?:bid="[^"]+"\s+link:|link\s+bid="[^"]+"))/,
	)) {
		const bid = firstDefined(
			block.match(/^\s*bid="([^"]+)"\s+link:/m)?.[1],
			block.match(/^\s*link\s+bid="([^"]+)"/m)?.[1],
		);
		if (bid && block.includes("[AUTH_IDENTIFIER_MATCH]")) {
			return bid;
		}
	}
	return undefined;
}

function buildAuthRuntimeChatYAMLMock() {
	return async (
		messages: Array<{ role?: string; content?: unknown }>,
		_llm: unknown,
		caller?: string,
	) => {
		const dom = String(messages?.[1]?.content ?? "");
		if (String(caller).startsWith("authTakeover:probe")) {
			const usernameBid = extractIdentifierBid(dom);
			const passwordBid = extractBid(
				dom,
				/input bid="([^"]+)"[^\n]*type="password"/i,
			);
			const continueBid = extractBid(
				dom,
				/button bid="([^"]+)"[^\n]*(Continue|Next)/i,
			);
			const submitBid = extractBid(
				dom,
				/button bid="([^"]+)"[^\n]*Sign in/i,
			);
			const stayLoggedInCheckboxBid = extractCheckboxBid(dom);
			const switchIdentifierBid = extractSwitchIdentifierBid(dom);
			const accountBid = extractAccountBid(dom);
			if (accountBid || switchIdentifierBid) {
				return {
					data: {
						action: "select_account",
						...(accountBid ? { accountBid } : {}),
						...(!accountBid && switchIdentifierBid
							? { switchIdentifierBid }
							: {}),
						reason: accountBid
							? "matching account"
							: "use another account",
					},
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			if (passwordBid && submitBid) {
				const data: Record<string, unknown> = {
					action: "submit_credentials",
					passwordBid,
					submitBid,
					reason: "fields present",
				};
				if (usernameBid) {
					data.usernameBid = usernameBid;
				}
				if (stayLoggedInCheckboxBid) {
					data.stayLoggedInCheckboxBid = stayLoggedInCheckboxBid;
				}
				if (switchIdentifierBid) {
					data.switchIdentifierBid = switchIdentifierBid;
				}
				return {
					data,
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			if (usernameBid && continueBid) {
				return {
					data: {
						action: "advance_identifier_step",
						usernameBid,
						continueBid,
						reason: "identifier first",
					},
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			if (usernameBid && !passwordBid && !submitBid) {
				return {
					data: {
						action: "advance_identifier_step",
						usernameBid,
						reason: "enter fallback",
					},
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			return {
				data: { action: "cannot_attempt", reason: "no-match" },
				usage: {
					input_tokens: 10,
					cached_input_tokens: 0,
					output_tokens: 5,
					total_tokens: 15,
				},
				reasoning_tokens: "",
			} as any;
		}

		return {
			data: {
				outcome: "success_or_redirect",
				reason: "dashboard visible",
			},
			usage: {
				input_tokens: 8,
				cached_input_tokens: 0,
				output_tokens: 4,
				total_tokens: 12,
			},
			reasoning_tokens: "",
		} as any;
	};
}

describe("auth runtime", () => {
	it("handles password-visible form directly with programmatic credential submission", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logMessages: string[] = [];
			let usernameValue = "";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};
			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						'input bid="u1" type="email" placeholder="Email"\ninput bid="p1" type="password" autocomplete="current-password"\ninput bid="stay1" type="checkbox" label="Remember me"\nbutton bid="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
						if (bid === "u1") {
							usernameValue = text;
						}
					},
					readIdentifierInputByBid: async () => ({
						value: usernameValue,
						editable: true,
					}),
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
					ensureCheckboxChecked: async (_browser, bid) => {
						interactions.push(`check:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com",
				"verify-password:p1",
				"type:p1:real-password",
				"check:stay1",
				"click:s1",
				"wait",
			]);
			assert.lengthOf(result.traceEntries, 2);
			assert.strictEqual(result.traceEntries[0]?.stage, "probe");
			assert.strictEqual(result.traceEntries[1]?.stage, "result");
			const probeMessages = result.traceEntries[0]?.messages ?? [];
			const resultMessages = result.traceEntries[1]?.messages ?? [];
			const probeRoles = probeMessages
				.map((entry) =>
					(entry as { role?: unknown }).role
						? String((entry as { role?: unknown }).role)
						: "",
				)
				.filter((role) => role.length > 0);
			const resultRoles = resultMessages
				.map((entry) =>
					(entry as { role?: unknown }).role
						? String((entry as { role?: unknown }).role)
						: "",
				)
				.filter((role) => role.length > 0);
			assert.deepEqual(probeRoles, ["system", "user", "assistant"]);
			assert.deepEqual(resultRoles, ["system", "user", "assistant"]);
			assert.notInclude(
				JSON.stringify(result.traceEntries),
				"real-password",
			);
			assert.strictEqual(sessionAuth.suppressScreenshots, false);
			assert.strictEqual(sessionAuth.protectedBids.size, 0);
			assert.isTrue(
				logMessages.some((entry) =>
					entry.includes("authTakeover:attempt_started"),
				),
			);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes("authTakeover:auth_fields_detected") &&
						entry.includes('"hasPasswordBid":true') &&
						entry.includes('"hasSubmitBid":true'),
				),
			);
		});
	});

	it("skips username typing when the visible identifier already matches", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						'input bid="u1" type="email" value="USER@example.com"\ninput bid="p1" type="password"\nbutton bid="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
					},
					readIdentifierInputByBid: async () => ({
						value: "USER@example.com",
						editable: true,
					}),
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assertNoSecretLeaksInText(JSON.stringify(result.traceEntries), [
				"real-password",
			]);
		});
	});

	it("replaces a mismatched editable identifier before submitting credentials", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let usernameValue = "other@example.com";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						'input bid="u1" type="email" value="other@example.com"\ninput bid="p1" type="password"\nbutton bid="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
						if (bid === "u1") {
							usernameValue = text;
						}
					},
					readIdentifierInputByBid: async () => ({
						value: usernameValue,
						editable: true,
					}),
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
		});
	});

	it("switches away from a mismatched non-editable identifier before login", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "mismatch" | "identifier" | "password" = "mismatch";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () => {
						if (stage === "mismatch") {
							return 'input bid="u1" type="email" value="other@example.com"\ninput bid="p1" type="password"\nbutton bid="sw1": "Use another email"\nbutton bid="s1": "Sign in"';
						}
						if (stage === "identifier") {
							return 'input bid="u2" type="email" placeholder="Email"\nbutton bid="c1": "Continue"';
						}
						return 'input bid="p1" type="password"\nbutton bid="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
					},
					readIdentifierInputByBid: async (_browser, bid) => ({
						value: bid === "u1" ? "other@example.com" : "",
						editable: bid !== "u1",
					}),
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
						if (bid === "sw1") {
							stage = "identifier";
						}
						if (bid === "c1") {
							stage = "password";
						}
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:sw1",
				"wait",
				"type:u2:user@example.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_switch_clicked",
			);
		});
	});

	it("submits password when selected account text matches without username input", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logs: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "john@test.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						'div:\n  bid="sw1" link: "john@test.com selected. Switch account"\n  input bid="p1" type="password" name="Passwd": "Enter your password"\n  button bid="s1": "Next"',
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: async (_messages, _llm, caller) => {
						if (caller?.startsWith("authTakeover:probe")) {
							return {
								data: {
									action: "submit_credentials",
									passwordBid: "p1",
									submitBid: "s1",
									switchIdentifierBid: "sw1",
									reason: "password step",
								},
								usage: {
									input_tokens: 10,
									cached_input_tokens: 0,
									output_tokens: 5,
									total_tokens: 15,
								},
								reasoning_tokens: "",
							} as any;
						}
						return {
							data: {
								outcome: "success_or_redirect",
								reason: "dashboard visible",
							},
							usage: {
								input_tokens: 8,
								cached_input_tokens: 0,
								output_tokens: 4,
								total_tokens: 12,
							},
							reasoning_tokens: "",
						} as any;
					},
					log: (message) => {
						logs.push(message);
					},
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
					},
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.include(
				result.traceEntries[0]?.outcomeReason ?? "",
				"identifier_text_matched",
			);
			assert.isTrue(
				logs.some((entry) =>
					entry.includes("authTakeover:identifier_text_matched"),
				),
			);
			assertNoSecretLeaksInText(JSON.stringify(result.traceEntries), [
				"real-password",
			]);
		});
	});

	it("switches account when selected account text mismatches without username input", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "mismatch" | "identifier" | "password" = "mismatch";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "john@test.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () => {
						if (stage === "mismatch") {
							return 'div:\n  bid="sw1" link: "other@example.com selected. Switch account"\n  input bid="p1" type="password" name="Passwd": "Enter your password"\n  button bid="s1": "Next"';
						}
						if (stage === "identifier") {
							return 'input bid="u1" type="email" placeholder="Email"\nbutton bid="c1": "Continue"';
						}
						return 'div: "john@test.com"\ninput bid="p1" type="password" name="Passwd": "Enter your password"\nbutton bid="s1": "Next"';
					},
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: async (_messages, _llm, caller) => {
						if (caller?.startsWith("authTakeover:probe")) {
							if (stage === "identifier") {
								return {
									data: {
										action: "advance_identifier_step",
										usernameBid: "u1",
										continueBid: "c1",
										reason: "identifier first",
									},
									usage: {
										input_tokens: 10,
										cached_input_tokens: 0,
										output_tokens: 5,
										total_tokens: 15,
									},
									reasoning_tokens: "",
								} as any;
							}
							return {
								data: {
									action: "submit_credentials",
									passwordBid: "p1",
									submitBid: "s1",
									...(stage === "mismatch"
										? { switchIdentifierBid: "sw1" }
										: {}),
									reason: "password step",
								},
								usage: {
									input_tokens: 10,
									cached_input_tokens: 0,
									output_tokens: 5,
									total_tokens: 15,
								},
								reasoning_tokens: "",
							} as any;
						}
						return {
							data: {
								outcome: "success_or_redirect",
								reason: "dashboard visible",
							},
							usage: {
								input_tokens: 8,
								cached_input_tokens: 0,
								output_tokens: 4,
								total_tokens: 12,
							},
							reasoning_tokens: "",
						} as any;
					},
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
						if (bid === "sw1") {
							stage = "identifier";
						}
						if (bid === "c1") {
							stage = "password";
						}
					},
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:sw1",
				"wait",
				"type:u1:john@test.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_switch_clicked",
			);
			assertNoSecretLeaksInText(JSON.stringify(result.traceEntries), [
				"real-password",
			]);
		});
	});

	it("selects a matching account chooser row before entering the password", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "chooser" | "password" = "chooser";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						stage === "chooser"
							? 'main:\n  "Choose an account"\n  ul:\n    bid="acct1" link:\n      bid="name1": "Test User"\n      bid="email1": "user@example.com"\n    bid="other1" link:\n      bid="other-text": "Use another account"'
							: 'input bid="p1" type="password"\nbutton bid="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
						if (bid === "acct1") {
							stage = "password";
						}
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:acct1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"account_selected",
			);
		});
	});

	it("uses another-account chooser option when configured account is absent", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "chooser" | "identifier" | "password" = "chooser";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () => {
						if (stage === "chooser") {
							return 'main:\n  "Choose an account"\n  ul:\n    bid="acct1" link:\n      bid="email1": "other@example.com"\n    bid="other1" link:\n      bid="other-text": "Use another account"';
						}
						if (stage === "identifier") {
							return 'input bid="u1" type="email" placeholder="Email"\nbutton bid="c1": "Continue"';
						}
						return 'input bid="p1" type="password"\nbutton bid="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
						if (bid === "other1") {
							stage = "identifier";
						}
						if (bid === "c1") {
							stage = "password";
						}
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:other1",
				"wait",
				"type:u1:user@example.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_switch_clicked",
			);
		});
	});

	it("falls back when a mismatched identifier cannot be changed safely", async () => {
		await withAuthEncryptionKey(async () => {
			const logs: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						'input bid="u1" type="email" value="other@example.com"\ninput bid="p1" type="password"\nbutton bid="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logs.push(message);
					},
					typeText: async () => {
						throw new Error("must not type");
					},
					readIdentifierInputByBid: async () => ({
						value: "other@example.com",
						editable: false,
					}),
				},
			});

			assert.isFalse(result.handled);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_mismatch",
			);
			assertNoSecretLeaksInText(JSON.stringify(logs), ["real-password"]);
		});
	});

	it("handles identifier-first flow and resolves password step after continue", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logMessages: string[] = [];
			let domCalls = 0;
			let passwordRequests = 0;
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};
			const originalPasswordRequest =
				sessionAuth.requestAuthPasswordForDomain!;
			sessionAuth.requestAuthPasswordForDomain = async (currentUrl) => {
				passwordRequests += 1;
				return await originalPasswordRequest(currentUrl);
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () => {
						domCalls += 1;
						return domCalls === 1
							? 'input bid="u1" type="email" placeholder="Email"\nbutton bid="c1": "Continue"'
							: 'input bid="p1" type="password"\nbutton bid="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async (_browser, bid, text) => {
						interactions.push(`type:${bid}:${text}`);
					},
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.strictEqual(sessionAuth.suppressScreenshots, false);
			assert.strictEqual(sessionAuth.protectedBids.size, 0);
			assert.strictEqual(passwordRequests, 1);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes(
							"authTakeover:identifier_step_completed",
						) &&
						entry.includes('"usedContinueBid":true') &&
						entry.includes('"usedEnterFallback":false'),
				),
			);
		});
	});

	it("uses Enter fallback when no continue or submit bid is detectable on identifier step", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logMessages: string[] = [];
			let domCalls = 0;
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () => {
						domCalls += 1;
						return domCalls === 1
							? 'input bid="u1" type="email" placeholder="Email"'
							: 'input bid="p1" type="password"\nbutton bid="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async (_browser, bid, text, enter) => {
						interactions.push(
							`type:${bid}:${text}:enter=${Boolean(enter)}`,
						);
					},
					click: async (_browser, bid) => {
						interactions.push(`click:${bid}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputBid: async (_browser, bid) => {
						interactions.push(`verify-password:${bid}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.strictEqual(sessionAuth.suppressScreenshots, false);
			assert.strictEqual(sessionAuth.protectedBids.size, 0);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com:enter=true",
				"wait",
				"verify-password:p1",
				"type:p1:real-password:enter=false",
				"click:s1",
				"wait",
			]);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes(
							"authTakeover:identifier_step_completed",
						) && entry.includes('"usedEnterFallback":true'),
				),
			);
		});
	});

	it("includes identifier step failure details in trace and unhandled logs", async () => {
		await withAuthEncryptionKey(async () => {
			const logMessages: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						'input bid="u1" type="email" placeholder="Email"\nbutton bid="c1": "Continue"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async () => {},
					click: async () => {
						throw new Error("continue button detached");
					},
				},
			});

			assert.isFalse(result.handled);
			assert.strictEqual(result.traceEntries[0]?.outcome, "unhandled");
			assert.include(
				result.traceEntries[0]?.outcomeReason ?? "",
				"identifier_step_failed: continue button detached",
			);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes('"reason":"identifier_step_failed"') &&
						entry.includes('"error":"continue button detached"'),
				),
			);
		});
	});

	it("stops before identifier/password lookup when no domain credential matches", async () => {
		let domainLookupOptions: AuthLookupOptions | undefined;
		let identifierLookups = 0;
		let passwordLookups = 0;
		const sessionAuth: SessionAuthTakeoverState = {
			enabled: true,
			requestAuthDomainCandidates: async (_currentUrl, options) => {
				domainLookupOptions = options;
				return [];
			},
			requestAuthIdentifierForDomain: async () => {
				identifierLookups += 1;
				return "user@example.com";
			},
			requestAuthPasswordForDomain: async () => {
				passwordLookups += 1;
				return "real-password";
			},
			protectedBids: new Set<string>(),
			suppressScreenshots: false,
		};

		const result = await attemptAutomatedAuthTakeover({
			deps: {
				getSimplifiedDOM: async () => "dom",
				getCurrentURL: async () => "https://idp.example.com/login",
			},
			browser: {} as any,
			sessionAuth,
		});

		assert.isFalse(result.handled);
		assert.deepEqual(domainLookupOptions, { purpose: "auth_takeover" });
		assert.strictEqual(identifierLookups, 0);
		assert.strictEqual(passwordLookups, 0);
	});

	it("falls back after four failed attempts within one takeover event", async () => {
		const logMessages: string[] = [];
		const result = await attemptAutomatedAuthTakeover({
			deps: {
				getSimplifiedDOM: async () =>
					'div bid="x1": "Sign in with SSO"',
				getCurrentURL: async () => "https://login.example.com/sign-in",
			},
			browser: {} as any,
			sessionAuth: {
				enabled: true,
				requestAuthDomainCandidates: async () => ["example.com"],
				requestAuthIdentifierForDomain: async () => "user@example.com",
				requestAuthPasswordForDomain: async () => "real-password",
				protectedBids: new Set<string>(),
				suppressScreenshots: false,
			},
			hooks: {
				log: (message) => {
					logMessages.push(message);
				},
			},
		});

		assert.isFalse(result.handled);
		assert.strictEqual(
			logMessages.filter((entry) =>
				entry.includes("authTakeover:attempt_started"),
			).length,
			4,
		);
		assert.isTrue(
			logMessages.some(
				(entry) =>
					entry.includes('"reason":"attempt_budget_exhausted"') &&
					entry.includes('"maxAttempts":4'),
			),
		);
	});

	it("uses step-indexed auth caller labels and trace step numbers", async () => {
		await withAuthEncryptionKey(async () => {
			const callers: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () =>
						'input bid="u1" type="email"\ninput bid="p1" type="password"\nbutton bid="s1": "Sign in"\ndiv: "Dashboard Ready"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				stepBaseIndex: 1,
				hooks: {
					chatYAML: async (_messages, _llm, caller) => {
						callers.push(caller ?? "");
						if (caller?.startsWith("authTakeover:probe:step")) {
							return {
								data: {
									action: "submit_credentials",
									usernameBid: "u1",
									passwordBid: "p1",
									submitBid: "s1",
									reason: "fields present",
								},
								usage: {
									input_tokens: 10,
									cached_input_tokens: 0,
									output_tokens: 5,
									total_tokens: 15,
								},
								reasoning_tokens: "probe-thinking",
							} as any;
						}
						return {
							data: {
								outcome: "success_or_redirect",
								reason: "dashboard visible",
							},
							usage: {
								input_tokens: 8,
								cached_input_tokens: 0,
								output_tokens: 4,
								total_tokens: 12,
							},
							reasoning_tokens: "result-thinking",
						} as any;
					},
					typeText: async () => {},
					readIdentifierInputByBid: async () => ({
						value: "user@example.com",
						editable: true,
					}),
					click: async () => {},
					waitForAllOpenTabsToSettle: async () => {},
					assertPasswordInputBid: async () => {},
				},
			});

			assert.isTrue(result.handled);
			assert.include(callers, "authTakeover:probe:step2");
			assert.include(callers, "authTakeover:result:step3");
			assert.strictEqual(result.traceEntries[0]?.step, 2);
			assert.strictEqual(result.traceEntries[0]?.stage, "probe");
			assert.strictEqual(result.traceEntries[1]?.step, 3);
			assert.strictEqual(result.traceEntries[1]?.stage, "result");
			const probeAssistantMessage = (
				result.traceEntries[0]?.messages ?? []
			).find(
				(message) =>
					(message as { role?: unknown }).role === "assistant",
			) as { reasoning_tokens?: string } | undefined;
			const resultAssistantMessage = (
				result.traceEntries[1]?.messages ?? []
			).find(
				(message) =>
					(message as { role?: unknown }).role === "assistant",
			) as { reasoning_tokens?: string } | undefined;
			assert.strictEqual(
				probeAssistantMessage?.reasoning_tokens,
				"probe-thinking",
			);
			assert.strictEqual(
				resultAssistantMessage?.reasoning_tokens,
				"result-thinking",
			);
		});
	});

	it("never leaks secrets in auth takeover logs", async () => {
		await withAuthEncryptionKey(async () => {
			const logs: string[] = [];
			const secretDomain =
				"https://login.example.com/sign-in?tenant=private-workspace";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: secretDomain,
					username: "secret-user@example.com",
					password: "ultra-secret-password",
				},
			})!;

			await attemptAutomatedAuthTakeover({
				deps: {
					getSimplifiedDOM: async () => "div: no form found",
					getCurrentURL: async () =>
						"https://login.example.com/sign-in?token=top-secret",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					log: (message) => {
						logs.push(message);
					},
				},
			});

			assertNoSecretLeaksInText(JSON.stringify(logs), [
				"ultra-secret-password",
				"private-workspace",
				"token=top-secret",
			]);
		});
	});
});
