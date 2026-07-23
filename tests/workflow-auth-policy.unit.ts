import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { LateWorkflowAuthenticationError } from "../src/auth/runtime.js";
import { assertAuthenticationBarrierCleared } from "../src/core/session.js";
import type { BrowserSession } from "../src/core/session-registry.js";

describe("workflow authentication policy", () => {
	it("blocks fan-out while preparation authentication is unresolved", () => {
		assert.throws(
			() =>
				assertAuthenticationBarrierCleared({
					workflowAuthenticationUnresolved: true,
				} as BrowserSession),
			/unresolved/,
		);
	});

	it("rejects late authentication before credential or user callbacks", async () => {
		let authAttempts = 0;
		let callbacks = 0;
		let error: unknown;
		try {
			await executeActions({
				b: {} as never,
				actions: [
					{
						type: "user_takeover",
						reason: "Sign in with a password.",
						category: "authentication",
					},
				],
				openTabs: [],
				memoryFile: "/tmp/workflow-auth-policy-memory.txt",
				authenticationPolicy: "reject",
				attemptAutomatedAuthTakeover: async () => {
					authAttempts += 1;
					return { handled: false };
				},
				onUserActionRequired: async () => {
					callbacks += 1;
				},
			});
		} catch (caught) {
			error = caught;
		}

		assert.instanceOf(error, LateWorkflowAuthenticationError);
		assert.strictEqual(authAttempts, 0);
		assert.strictEqual(callbacks, 0);
	});
});
