import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";
import { runTrainingRollout } from "../src/core/training-rollout.js";
import { setRuntimeOptions } from "../src/runtime-options.js";

describe("runTrainingRollout", () => {
	beforeEach(() => {
		setRuntimeOptions({ saveStepsContext: false });
	});

	afterEach(() => {
		setRuntimeOptions({ saveStepsContext: true });
	});

	it("captures prompt, generation, and browse artifacts from the official harness", async () => {
		const deps = createMockCoreDeps({
			userActionBehavior: "return",
			executeActions: async ({ actions }) => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				pendingPlanRegeneration: false,
				screenshotToolObservations: [],
				screenshotToolCaptures: [],
				...(actions.some((action) => action.type === "return_results")
					? { returnedResult: "Success" }
					: {}),
			}),
		});
		let callCount = 0;

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Finish the task",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				dismissCookieBanner: { provider: "openai", model: "gpt-test" },
				createPlan: { provider: "openai", model: "gpt-test" },
				preExecutionDomPruning: {
					provider: "openai",
					model: "gpt-test",
				},
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			userActionBehavior: "return",
			maxSteps: 2,
			generateStep: async ({ messages, promptPayload, stepKind }) => {
				callCount += 1;
				assert.isArray(messages);
				assert.strictEqual(
					stepKind,
					callCount === 1 ? "executor_step" : "max_step_finalization",
				);
				assert.strictEqual(
					promptPayload.currentURL,
					"https://target.example",
				);
				if (callCount === 1) {
					return {
						data: {
							thinking: "Click",
							actions: [{ type: "click", bid: "1" }],
							done: false,
						},
						usage: {
							input_tokens: 12,
							output_tokens: 4,
							total_tokens: 16,
						},
						reasoning_tokens: "reasoning",
						rawModelOutputText:
							"reasoning\n</think>\n\nthinking: Click",
						promptTokenIds: [1, 2, 3],
						completionTokenIds: [4, 5],
						studentLogprobs: [-0.1, -0.2],
						teacherPromptMessages: [
							{ role: "user", content: "teacher" },
						],
					};
				}
				return {
					data: {
						thinking: "Return results",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 12,
						output_tokens: 4,
						total_tokens: 16,
					},
					reasoning_tokens: "reasoning",
					rawModelOutputText: "reasoning\n</think>\n\nthinking: Done",
					promptTokenIds: [1, 2, 3],
					completionTokenIds: [4, 5],
					studentLogprobs: [-0.1, -0.2],
					teacherPromptMessages: [
						{ role: "user", content: "teacher" },
					],
				};
			},
		});

		assert.strictEqual(callCount, 2);
		assert.isTrue(result.run.completed);
		assert.isTrue(result.run.successful);
		assert.lengthOf(result.steps, 2);
		assert.deepEqual(result.steps[0].promptTokenIds, [1, 2, 3]);
		assert.deepEqual(result.steps[0].completionTokenIds, [4, 5]);
		assert.deepEqual(result.steps[0].studentLogprobs, [-0.1, -0.2]);
		assert.strictEqual(
			result.steps[0].rawModelOutputText,
			"reasoning\n</think>\n\nthinking: Click",
		);
		assert.strictEqual(
			result.steps[0].promptPayload.currentURL,
			"https://target.example",
		);
		assert.strictEqual(result.steps[0].normalizedStep.done, false);
		assert.isDefined(result.steps[0].browse);
		assert.strictEqual(result.steps[1].terminal?.successful, true);
		for (const loopEntry of result.run.mainLoopEntries) {
			const assistantContent = String(
				loopEntry.messages.at(-1)?.content ?? "",
			);
			assert.notInclude(assistantContent, "done:");
			assert.notInclude(assistantContent, "result:");
		}
	});

	it("preserves validator-backed unsuccessful terminal results from return_results", async () => {
		const deps = createMockCoreDeps({
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				pendingPlanRegeneration: false,
				screenshotToolObservations: [],
				screenshotToolCaptures: [],
				returnedResult: "Claimed success",
			}),
			verifyTaskSuccess: async () => ({
				success: false,
				summary: "Missing artifact",
				reasons: ["missing artifact"],
				model: "gpt-test",
				provider: "openai",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
			}),
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9333,
				headless: true,
				forceRestart: true,
			},
			task: "Report completion",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				dismissCookieBanner: { provider: "openai", model: "gpt-test" },
				createPlan: { provider: "openai", model: "gpt-test" },
				preExecutionDomPruning: {
					provider: "openai",
					model: "gpt-test",
				},
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 2,
			generateStep: async () => ({
				data: {
					thinking: "Return the result",
					actions: [{ type: "return_results" }],
					done: false,
				},
				usage: {
					input_tokens: 7,
					output_tokens: 2,
					total_tokens: 9,
				},
				reasoning_tokens: "",
				rawModelOutputText: "thinking: Return the result",
			}),
		});

		assert.isTrue(result.run.completed);
		assert.isFalse(result.run.successful);
		assert.strictEqual(result.steps[0].terminal?.completed, true);
		assert.strictEqual(result.steps[0].terminal?.successful, false);
		assert.strictEqual(
			result.steps[0].terminal?.successVerification?.summary,
			"Missing artifact",
		);
	});

	it("continues with bounded validator feedback and accepts a corrected result", async () => {
		let resultCalls = 0;
		let verificationCalls = 0;
		let secondPromptPayload: Record<string, unknown> | undefined;
		const deps = createMockCoreDeps({
			executeActions: async () => {
				resultCalls += 1;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					pendingPlanRegeneration: false,
					screenshotToolObservations: [],
					screenshotToolCaptures: [],
					returnedResult:
						resultCalls === 1
							? "Incomplete answer"
							: "Corrected answer",
				};
			},
			verifyTaskSuccess: async () => {
				verificationCalls += 1;
				return {
					success: verificationCalls > 1,
					summary:
						verificationCalls === 1
							? "A required field is missing."
							: "Task succeeded.",
					reasons:
						verificationCalls === 1
							? ["Include the missing required field."]
							: [],
					model: "gpt-test",
					provider: "openai",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				};
			},
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9388,
				headless: true,
				forceRestart: true,
			},
			task: "Return every required field",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				dismissCookieBanner: { provider: "openai", model: "gpt-test" },
				createPlan: { provider: "openai", model: "gpt-test" },
				preExecutionDomPruning: {
					provider: "openai",
					model: "gpt-test",
				},
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 3,
			validatorLifecycle: { mode: "retry", maxFailures: 3 },
			generateStep: async ({ stepNumber, promptPayload }) => {
				if (stepNumber === 2) secondPromptPayload = promptPayload;
				return {
					data: {
						thinking:
							stepNumber === 1
								? "Return initial result"
								: "Fix the rejected result",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 7,
						output_tokens: 2,
						total_tokens: 9,
					},
					reasoning_tokens: "",
					rawModelOutputText: `step ${stepNumber}`,
				};
			},
		});

		assert.strictEqual(resultCalls, 2);
		assert.strictEqual(verificationCalls, 2);
		assert.isTrue(result.run.completed);
		assert.isTrue(result.run.successful);
		assert.strictEqual(result.run.result, "Corrected answer");
		assert.deepInclude(secondPromptPayload?.validatorFeedback, {
			failure: 1,
			maxFailures: 3,
			summary: "A required field is missing.",
			reasons: ["Include the missing required field."],
		});
		assert.deepInclude(result.run.stepsHistory[1]?.payload, {
			validatorFeedback: secondPromptPayload?.validatorFeedback,
		});
	});

	it("stops after the configured number of validator failures", async () => {
		let resultCalls = 0;
		let verificationCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async () => {
				resultCalls += 1;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					pendingPlanRegeneration: false,
					screenshotToolObservations: [],
					screenshotToolCaptures: [],
					returnedResult: `Rejected answer ${resultCalls}`,
				};
			},
			verifyTaskSuccess: async () => {
				verificationCalls += 1;
				return {
					success: false,
					summary: `Rejected ${verificationCalls}`,
					reasons: ["Still incomplete."],
					model: "gpt-test",
					provider: "openai",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				};
			},
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9399,
				headless: true,
				forceRestart: true,
			},
			task: "Return every required field",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				dismissCookieBanner: { provider: "openai", model: "gpt-test" },
				createPlan: { provider: "openai", model: "gpt-test" },
				preExecutionDomPruning: {
					provider: "openai",
					model: "gpt-test",
				},
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 5,
			validatorLifecycle: { mode: "retry", maxFailures: 3 },
			generateStep: async ({ stepNumber }) => ({
				data: {
					thinking: `Attempt ${stepNumber}`,
					actions: [{ type: "return_results" }],
					done: false,
				},
				usage: {
					input_tokens: 7,
					output_tokens: 2,
					total_tokens: 9,
				},
				reasoning_tokens: "",
				rawModelOutputText: `step ${stepNumber}`,
			}),
		});

		assert.strictEqual(resultCalls, 3);
		assert.strictEqual(verificationCalls, 3);
		assert.isTrue(result.run.completed);
		assert.isFalse(result.run.successful);
		assert.strictEqual(result.run.result, "Rejected answer 3");
		assert.lengthOf(result.run.stepsHistory, 3);
	});

	it("preserves user takeover as terminal metadata on the final step", async () => {
		const deps = createMockCoreDeps({
			userActionBehavior: "return",
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				pendingPlanRegeneration: false,
				screenshotToolObservations: [],
				screenshotToolCaptures: [],
				userTakeover: {
					reason: "Please log in",
					category: "authentication",
				},
			}),
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9444,
				headless: true,
				forceRestart: true,
			},
			task: "Login required",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				dismissCookieBanner: { provider: "openai", model: "gpt-test" },
				createPlan: { provider: "openai", model: "gpt-test" },
				preExecutionDomPruning: {
					provider: "openai",
					model: "gpt-test",
				},
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			userActionBehavior: "return",
			maxSteps: 2,
			generateStep: async () => ({
				data: {
					thinking: "Need manual login",
					actions: [
						{
							type: "user_takeover",
							request: "Please log in",
							category: "authentication",
						},
					],
					done: false,
				},
				usage: {
					input_tokens: 4,
					output_tokens: 1,
					total_tokens: 5,
				},
				reasoning_tokens: "",
				rawModelOutputText: "thinking: takeover",
			}),
		});

		assert.isFalse(result.run.completed);
		assert.deepEqual(result.run.userActionRequired, {
			kind: "browser_user_takeover",
			reason: "Please log in",
			category: "authentication",
		});
		assert.deepEqual(result.steps[0].terminal?.userActionRequired, {
			kind: "browser_user_takeover",
			reason: "Please log in",
			category: "authentication",
		});
	});

	it("drops artifacts from failed step attempts before retry succeeds", async () => {
		let actionCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async () => {
				actionCalls += 1;
				if (actionCalls === 1) {
					throw new Error("transient browse failure");
				}
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					pendingPlanRegeneration: false,
					screenshotToolObservations: [],
					screenshotToolCaptures: [],
				};
			},
		});
		let generationCalls = 0;

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9555,
				headless: true,
				forceRestart: true,
			},
			task: "Retry after transient failure",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				dismissCookieBanner: { provider: "openai", model: "gpt-test" },
				createPlan: { provider: "openai", model: "gpt-test" },
				preExecutionDomPruning: {
					provider: "openai",
					model: "gpt-test",
				},
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 2,
			generateStep: async ({ stepNumber }) => {
				generationCalls += 1;
				return stepNumber === 1
					? {
							data: {
								thinking: "Click",
								actions: [{ type: "click", bid: "1" }],
								done: false,
							},
							usage: {
								input_tokens: 5,
								output_tokens: 1,
								total_tokens: 6,
							},
							reasoning_tokens: "",
							rawModelOutputText: `attempt ${generationCalls}`,
						}
					: {
							data: {
								thinking: "Done",
								actions: [],
								done: true,
								result: "Success",
							},
							usage: {
								input_tokens: 5,
								output_tokens: 1,
								total_tokens: 6,
							},
							reasoning_tokens: "",
							rawModelOutputText: "final",
						};
			},
		});

		assert.strictEqual(actionCalls, 2);
		assert.strictEqual(generationCalls, 3);
		assert.lengthOf(result.steps, 2);
		assert.strictEqual(result.steps[0].rawModelOutputText, "attempt 2");
		assert.strictEqual(result.steps[1].rawModelOutputText, "final");
	});
});
