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

const MIN_WORKFLOW_NODES = 3;
const MAX_WORKFLOW_NODES = 8;
const WORKFLOW_SCHEMA_MAX_ATTEMPTS = 3;

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
	- task: Prepare the shared browser context and resources needed by downstream nodes.
		dependsOn: []
	- task: A bounded browser subtask with a concrete result.
		dependsOn: [1]
	- task: A follow-up bounded subtask that uses relevant parent results.
		dependsOn: [2]

Example 3:
	mode: workflow
	reason: Brief reason parallel execution is useful.
	nodes:
	- task: Prepare the shared browser context and resources needed by downstream nodes.
		dependsOn: []
	- task: Complete one independent bounded subtask and return a concrete result.
		dependsOn: [1]
	- task: Complete another independent bounded subtask and return a concrete result.
		dependsOn: [1]

- Choose direct for simple tasks, including tasks that are naturally handled in one short browser trajectory. 
- Choose workflow only when the task has meaningful independent work, useful parallelism, or multiple ordered substeps that justify orchestration overhead.
- A workflow should contain a maximum of 10 nodes 
- If using workflow mode, do not attempt to solve any parts of the task when rewording the task into subtasks. For example, you should not include any part of answers in node task, unless it is present in the original task.
- Dependencies must refer only to earlier nodes. 
- The nodes are browser agents only, so each task should be a task well suited for a browser agent
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
): WorkflowNode {
	const source = asObject(value, `Workflow node ${index + 1}`);
	if ("id" in source || "kind" in source) {
		throw new WorkflowDecisionValidationError(
			`Workflow node ${index + 1} must not include id or kind.`,
		);
	}
	const id = workflowNodeId(index);
	return {
		id,
		kind: index === 0 ? "preparation" : "task",
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

export function validateWorkflowDecision(value: unknown): WorkflowDecision {
	const source = asObject(value, "Workflow decision");
	const mode = asNonEmptyString(source.mode, "Workflow decision mode");
	const reason = asNonEmptyString(source.reason, "Workflow decision reason");
	if (mode === "direct") return { mode, reason };
	if (mode !== "workflow") {
		throw new WorkflowDecisionValidationError(
			`Unsupported workflow decision mode '${mode}'.`,
		);
	}
	if (!Array.isArray(source.nodes)) {
		throw new WorkflowDecisionValidationError(
			"Workflow decision nodes must be a list.",
		);
	}
	const nodeSources = source.nodes;
	if (
		nodeSources.length < MIN_WORKFLOW_NODES ||
		nodeSources.length > MAX_WORKFLOW_NODES
	) {
		throw new WorkflowDecisionValidationError(
			`Workflow must contain ${MIN_WORKFLOW_NODES} to ${MAX_WORKFLOW_NODES} nodes.`,
		);
	}

	const nodes = nodeSources.map((node, index) =>
		parseWorkflowNode(node, index, nodeSources.length),
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

	const preparations = nodes.filter((node) => node.kind === "preparation");
	if (preparations.length !== 1 || preparations[0].dependsOn.length !== 0) {
		throw new WorkflowDecisionValidationError(
			"Workflow must have exactly one preparation root.",
		);
	}
	const roots = nodes.filter((node) => node.dependsOn.length === 0);
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
	return { mode, reason, nodes };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return (
		signal?.aborted === true ||
		(error instanceof Error && error.name === "AbortError")
	);
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
