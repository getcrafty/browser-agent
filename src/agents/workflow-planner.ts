import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";
import { chatYAML } from "./providers/router.js";
import type {
	LLMOptions,
	Message,
	StageModelInvocationTrace,
} from "./types.js";
import type {
	WorkflowDecision,
	WorkflowNode,
} from "../core/workflow-types.js";

const MIN_WORKFLOW_NODES = 2;
const MAX_WORKFLOW_NODES = 8;
const WORKFLOW_SCHEMA_MAX_ATTEMPTS = 3;
const MAX_WORKFLOW_EXPANSION_NODES = 4;
const WORKFLOW_EXPANSION_MAX_ATTEMPTS = 4;

export const WORKFLOW_PLANNER_SYSTEM = `
You decide whether a browser task should run as one browser agent or as a directed acyclic graph (DAG) of browser agents.
Return YAML only, using exactly one of these shapes. 
All task descriptions in the workflow shape below are examples only to demonstrate what a valid schema looks like.

Example 1: 
	mode: direct
	reason: Brief reason the single-agent path is sufficient.

Example 2:
	mode: workflow
	reason: Brief reason orchestration is useful.
	nodes:
	- type: normal
		task: Prepare the shared browser context and resources needed by downstream nodes.
		dependsOn: []
	- type: normal
		task: A bounded browser subtask with a concrete result.
		dependsOn: [1]
	- type: normal
		task: A follow-up bounded subtask that uses relevant parent results.
		dependsOn: [2]

Example 3:
	mode: workflow
	reason: Brief reason parallel execution is useful.
	nodes:
	- type: normal
		task: Prepare the shared browser context and resources needed by downstream nodes.
		dependsOn: []
	- type: normal
		task: Complete one independent bounded subtask and return a concrete result.
		dependsOn: [1]
	- type: normal
		task: Complete another independent bounded subtask and return a concrete result.
		dependsOn: [1]

- Choose direct for simple tasks, including tasks that are naturally handled in one short browser trajectory. 
- Choose workflow only when the task has meaningful independent work, useful parallelism, or multiple ordered substeps that justify orchestration overhead.
- A workflow should contain a maximum of 8 nodes
- Each node may use type: normal or type: orchestrator. Omitted type defaults to normal.
- Root nodes must be normal. An orchestrator node waits for its dependencies, then recalls orchestration using their completed results instead of doing browser work.
- If using workflow mode, do not attempt to solve any parts of the task when rewording the task into subtasks. For example, you should not include any part of answers in node task, unless it is present in the original task.
- Dependencies must refer only to earlier nodes. 
- Normal nodes are browser agents, so each normal task should be well suited for a browser agent
- Dont include verification steps or post processing steps
- Only when the task requires authentication or shared origin setup, handle it in the first node whenever possible, before any branch runs so subsequent nodes inherit that browser state.`;

export class WorkflowDecisionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowDecisionValidationError";
	}
}

export interface WorkflowPlanningOutcome {
	decision: WorkflowDecision;
	fallbackReason?: string;
}

export interface PlanWorkflowInput {
	task: string;
	llmOptions: LLMOptions;
	abortSignal?: AbortSignal;
	onTrace?: (trace: StageModelInvocationTrace) => void;
	traceMeta?: Record<string, unknown>;
	/** Test/integration seam for runtimes that supply their own model transport. */
	requestDecision?: (input: {
		messages: Message[];
		llmOptions: LLMOptions;
		abortSignal?: AbortSignal;
	}) => Promise<unknown>;
}

export interface PlanWorkflowExpansionInput extends PlanWorkflowInput {
	workflowNodeId: string;
}

export class WorkflowExpansionPlanningError extends Error {
	constructor() {
		super("Workflow orchestration expansion failed.");
		this.name = "WorkflowExpansionPlanningError";
	}
}

function asObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new WorkflowDecisionValidationError(`${label} must be a map.`);
	}
	return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new WorkflowDecisionValidationError(
			`${label} must be a non-empty string.`,
		);
	}
	return value.trim();
}

function workflowNodeId(index: number): string {
	return `node_${index + 1}`;
}

function parseDependsOn(
	value: unknown,
	nodeIndex: number,
	nodeCount: number,
): string[] {
	const nodeId = workflowNodeId(nodeIndex);
	if (!Array.isArray(value)) {
		throw new WorkflowDecisionValidationError(
			`Workflow node '${nodeId}' dependsOn must be a list.`,
		);
	}
	const positions = value.map((dependency, index) => {
		if (!Number.isInteger(dependency)) {
			throw new WorkflowDecisionValidationError(
				`Workflow node '${nodeId}' dependency ${index + 1} must be a 1-based node position.`,
			);
		}
		const position = dependency as number;
		if (position < 1 || position > nodeCount) {
			throw new WorkflowDecisionValidationError(
				`Workflow node '${nodeId}' has unknown dependency position '${position}'.`,
			);
		}
		if (position > nodeIndex) {
			throw new WorkflowDecisionValidationError(
				`Workflow node '${nodeId}' dependencies must refer to earlier nodes.`,
			);
		}
		return position;
	});
	if (new Set(positions).size !== positions.length) {
		throw new WorkflowDecisionValidationError(
			`Workflow node '${nodeId}' contains duplicate dependencies.`,
		);
	}
	return positions.map((position) => workflowNodeId(position - 1));
}

function parseWorkflowNode(
	value: unknown,
	index: number,
	nodeCount: number,
	mode: "initial" | "expansion",
): WorkflowNode {
	const source = asObject(value, `Workflow node ${index + 1}`);
	if ("id" in source || "kind" in source) {
		throw new WorkflowDecisionValidationError(
			`Workflow node ${index + 1} must not include id or kind.`,
		);
	}
	const type = source.type ?? "normal";
	if (type !== "normal" && type !== "orchestrator") {
		throw new WorkflowDecisionValidationError(
			`Workflow node ${index + 1} type must be normal or orchestrator.`,
		);
	}
	if (mode === "expansion" && type === "orchestrator") {
		throw new WorkflowDecisionValidationError(
			"Expanded workflow nodes must be normal.",
		);
	}
	if (mode === "initial" && index === 0 && type === "orchestrator") {
		throw new WorkflowDecisionValidationError(
			"Workflow root nodes must be normal.",
		);
	}
	const id = workflowNodeId(index);
	return {
		id,
		kind:
			mode === "initial" && index === 0
				? "preparation"
				: type === "orchestrator"
					? "orchestrator"
					: "task",
		task: asNonEmptyString(source.task, `Workflow node '${id}' task`),
		dependsOn: parseDependsOn(
			source.dependsOn ?? source.depends_on,
			index,
			nodeCount,
		),
	};
}

function buildDependents(nodes: WorkflowNode[]): Map<string, string[]> {
	const dependents = new Map(nodes.map((node) => [node.id, [] as string[]]));
	for (const node of nodes) {
		for (const dependency of node.dependsOn) {
			dependents.get(dependency)?.push(node.id);
		}
	}
	return dependents;
}

function assertAcyclic(nodes: WorkflowNode[]): void {
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const state = new Map<string, "visiting" | "visited">();
	const visit = (nodeId: string): void => {
		if (state.get(nodeId) === "visiting") {
			throw new WorkflowDecisionValidationError(
				"Workflow dependencies contain a cycle.",
			);
		}
		if (state.get(nodeId) === "visited") return;
		state.set(nodeId, "visiting");
		for (const dependency of nodeById.get(nodeId)?.dependsOn ?? []) {
			visit(dependency);
		}
		state.set(nodeId, "visited");
	};
	for (const node of nodes) visit(node.id);
}

function collectReachable(
	start: string,
	edges: Map<string, string[]>,
): Set<string> {
	const visited = new Set<string>();
	const pending = [start];
	while (pending.length > 0) {
		const nodeId = pending.pop() as string;
		if (visited.has(nodeId)) continue;
		visited.add(nodeId);
		pending.push(...(edges.get(nodeId) ?? []));
	}
	return visited;
}

function validateWorkflowShape(
	value: unknown,
	validationMode: "initial" | "expansion",
): WorkflowDecision {
	const source = asObject(value, "Workflow decision");
	const decisionMode = asNonEmptyString(source.mode, "Workflow decision mode");
	const reason = asNonEmptyString(source.reason, "Workflow decision reason");
	if (decisionMode === "direct") return { mode: decisionMode, reason };
	if (decisionMode !== "workflow") {
		throw new WorkflowDecisionValidationError(
			`Unsupported workflow decision mode '${decisionMode}'.`,
		);
	}
	if (!Array.isArray(source.nodes)) {
		throw new WorkflowDecisionValidationError(
			"Workflow decision nodes must be a list.",
		);
	}
	const nodeSources = source.nodes;
	const minimumNodes = validationMode === "initial" ? MIN_WORKFLOW_NODES : 1;
	const maximumNodes =
		validationMode === "initial"
			? MAX_WORKFLOW_NODES
			: MAX_WORKFLOW_EXPANSION_NODES;
	if (nodeSources.length < minimumNodes || nodeSources.length > maximumNodes) {
		throw new WorkflowDecisionValidationError(
			`Workflow must contain ${minimumNodes} to ${maximumNodes} nodes.`,
		);
	}

	const nodes = nodeSources.map((node, index) =>
		parseWorkflowNode(node, index, nodeSources.length, validationMode),
	);
	const nodeById = new Map<string, WorkflowNode>();
	for (const node of nodes) {
		if (nodeById.has(node.id)) {
			throw new WorkflowDecisionValidationError(
				`Workflow node id '${node.id}' is duplicated.`,
			);
		}
		nodeById.set(node.id, node);
	}
	for (const node of nodes) {
		for (const dependency of node.dependsOn) {
			if (!nodeById.has(dependency)) {
				throw new WorkflowDecisionValidationError(
					`Workflow node '${node.id}' has unknown dependency '${dependency}'.`,
				);
			}
			if (dependency === node.id) {
				throw new WorkflowDecisionValidationError(
					`Workflow node '${node.id}' cannot depend on itself.`,
				);
			}
		}
	}
	assertAcyclic(nodes);

	const roots = nodes.filter((node) => node.dependsOn.length === 0);
	if (roots.some((node) => node.kind === "orchestrator")) {
		throw new WorkflowDecisionValidationError(
			"Workflow root nodes must be normal.",
		);
	}
	if (validationMode === "expansion") {
		return { mode: "workflow", reason, nodes };
	}

	const preparations = nodes.filter((node) => node.kind === "preparation");
	if (preparations.length !== 1 || preparations[0].dependsOn.length !== 0) {
		throw new WorkflowDecisionValidationError(
			"Workflow must have exactly one preparation root.",
		);
	}
	if (roots.length !== 1 || roots[0].id !== preparations[0].id) {
		throw new WorkflowDecisionValidationError(
			"Workflow preparation must be the only root.",
		);
	}

	const dependents = buildDependents(nodes);
	const fromPreparation = collectReachable(preparations[0].id, dependents);
	if (fromPreparation.size !== nodes.length) {
		throw new WorkflowDecisionValidationError(
			"Every workflow node must descend from preparation.",
		);
	}
	return { mode: "workflow", reason, nodes };
}

export function validateWorkflowDecision(value: unknown): WorkflowDecision {
	return validateWorkflowShape(value, "initial");
}

export function validateWorkflowExpansion(
	value: unknown,
): Extract<WorkflowDecision, { mode: "workflow" }> {
	const decision = validateWorkflowShape(value, "expansion");
	if (decision.mode !== "workflow") {
		throw new WorkflowDecisionValidationError(
			"Workflow expansion must use workflow mode.",
		);
	}
	return decision;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return (
		signal?.aborted === true ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Workflow planning was aborted.");
	error.name = "AbortError";
	throw error;
}

export async function planWorkflow(
	input: PlanWorkflowInput,
): Promise<WorkflowPlanningOutcome> {
	const messages: Message[] = [
		{ role: "system", content: WORKFLOW_PLANNER_SYSTEM },
		{ role: "user", content: `Task: ${input.task}` },
	];
	try {
		let lastValidationError: WorkflowDecisionValidationError | undefined;
		for (
			let schemaAttempt = 1;
			schemaAttempt <= WORKFLOW_SCHEMA_MAX_ATTEMPTS;
			schemaAttempt += 1
		) {
			const data = input.requestDecision
				? await input.requestDecision({
						messages,
						llmOptions: input.llmOptions,
						abortSignal: input.abortSignal,
					})
				: (
						await chatYAML<unknown>(
							messages,
							input.llmOptions,
							"workflowPlanner",
							(trace) =>
								input.onTrace?.(
									buildStageModelInvocationTrace({
										stage: "workflowPlanner",
										trace,
										meta: {
											phase: "workflow_planning",
											workflowSchemaAttempt:
												schemaAttempt,
											...(input.traceMeta ?? {}),
										},
									}),
								),
							input.abortSignal,
						)
					).data;
			try {
				return { decision: validateWorkflowDecision(data) };
			} catch (error) {
				if (!(error instanceof WorkflowDecisionValidationError)) {
					throw error;
				}
				lastValidationError = error;
			}
		}
		throw lastValidationError;
	} catch (error) {
		if (isAbort(error, input.abortSignal)) throw error;
		const fallbackReason =
			error instanceof WorkflowDecisionValidationError
				? error.message
				: "Workflow planner was unavailable.";
		return {
			decision: {
				mode: "direct",
				reason: "Workflow planning failed; using the direct agent path.",
			},
			fallbackReason,
		};
	}
}

export async function planWorkflowExpansion(
	input: PlanWorkflowExpansionInput,
): Promise<Extract<WorkflowDecision, { mode: "workflow" }>> {
	const messages: Message[] = [
		{ role: "system", content: WORKFLOW_PLANNER_SYSTEM },
		{
			role: "user",
			content: `Task: ${input.task}\n\nThis is a deferred workflow expansion. Return workflow mode with 1 to ${MAX_WORKFLOW_EXPANSION_NODES} normal nodes. Multiple root nodes are allowed.`,
		},
	];
	for (
		let expansionAttempt = 1;
		expansionAttempt <= WORKFLOW_EXPANSION_MAX_ATTEMPTS;
		expansionAttempt += 1
	) {
		try {
			throwIfAborted(input.abortSignal);
			const data = input.requestDecision
				? await input.requestDecision({
						messages,
						llmOptions: input.llmOptions,
						abortSignal: input.abortSignal,
					})
				: (
						await chatYAML<unknown>(
							messages,
							input.llmOptions,
							"workflowPlanner",
							(trace) =>
								input.onTrace?.(
									buildStageModelInvocationTrace({
										stage: "workflowPlanner",
										trace,
										meta: {
											phase: "workflow_expansion",
											workflowNodeId: input.workflowNodeId,
											workflowNodeKind: "orchestrator",
											expansionAttempt,
											...(input.traceMeta ?? {}),
										},
									}),
								),
							input.abortSignal,
						)
					).data;
			throwIfAborted(input.abortSignal);
			return validateWorkflowExpansion(data);
		} catch (error) {
			if (isAbort(error, input.abortSignal)) throw error;
			if (expansionAttempt === WORKFLOW_EXPANSION_MAX_ATTEMPTS) {
				throw new WorkflowExpansionPlanningError();
			}
		}
	}
	throw new WorkflowExpansionPlanningError();
}
