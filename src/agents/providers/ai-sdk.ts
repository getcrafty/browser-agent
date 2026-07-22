import {
	generateText,
	LanguageModelUsage,
	ReasoningOutput,
	streamText,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import OpenAI from "openai";
import type { LLMOptions, TokenUsage, Provider } from "../types.js";
import {
	getReasoningModelCapability,
	validateReasoningConfiguration,
} from "../reasoning-capabilities.js";

const TOGETHER_DEFAULT_BASE_URL = "https://api.together.xyz/v1";
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export const SUPPORTED_MODEL_PROVIDERS = [
	{
		id: "openai",
		adapter: "openai",
		requiresApiKey: true,
	},
	{
		id: "vllm",
		adapter: "openai-compatible",
		requiresApiKey: false,
	},
	{
		id: "anthropic",
		adapter: "anthropic",
		requiresApiKey: true,
	},
	{
		id: "google",
		adapter: "google",
		requiresApiKey: true,
	},
	{
		id: "together",
		adapter: "openai-compatible",
		requiresApiKey: true,
	},
	{
		id: "openrouter",
		adapter: "openrouter",
		requiresApiKey: true,
	},
] as const;

type ProviderDefinition = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

type ProviderAdapter = ProviderDefinition["adapter"];

interface ProviderRuntimeConfig {
	provider: Provider;
	adapter: ProviderAdapter;
	apiKey?: string;
	endpointUrl?: string;
}

function buildOpenRouterModelSettings() {
	return { usage: { include: true } } as const;
}

export interface ProviderChatArgs {
	options: LLMOptions;
	prompt: string;
	abortSignal?: AbortSignal;
	onOutputChunk?: (chunk: string) => void;
	onLifecycleEvent?: (event: ProviderChatLifecycleEvent) => void;
}

export type ProviderChatLifecycleEvent =
	| {
			type: "first_delta";
			deltaType: "text" | "reasoning";
	  }
	| { type: "first_text_delta" }
	| {
			type: "text_stream_complete";
			chunkCount: number;
			outputCharacters: number;
	  }
	| { type: "usage_complete" };

let openaiClient: OpenAI | null = null;
let providerChatOverride:
	| ((args: ProviderChatArgs) => Promise<{
			content: string;
			usage: TokenUsage;
			reasoning_tokens: string;
	  }>)
	| null = null;
const perProviderOverrides = new Map<
	Provider,
	| ((args: ProviderChatArgs) => Promise<{
			content: string;
			usage: TokenUsage;
			reasoning_tokens: string;
	  }>)
	| null
>();

function getProviderDefinition(provider: Provider): ProviderDefinition {
	const definition = SUPPORTED_MODEL_PROVIDERS.find(
		(entry) => entry.id === provider,
	);
	if (!definition) {
		throw new Error(`Unsupported provider '${provider}'.`);
	}
	return definition;
}

function readEnvString(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveEnvApiKey(provider: Provider): string | undefined {
	if (provider === "openai") {
		return readEnvString("OPENAI_API_KEY");
	}
	if (provider === "anthropic") {
		return readEnvString("ANTHROPIC_API_KEY");
	}
	if (provider === "google") {
		return readEnvString("GOOGLE_API_KEY");
	}
	if (provider === "together") {
		return readEnvString("TOGETHER_API_KEY");
	}
	if (provider === "openrouter") {
		return readEnvString("OPENROUTER_API_KEY");
	}
	return readEnvString("VLLM_API_KEY") || readEnvString("OPENAI_API_KEY");
}

function resolveApiKey(options: LLMOptions): string | undefined {
	const explicitApiKey = options.apiKey?.trim();
	if (explicitApiKey) {
		return explicitApiKey;
	}
	return resolveEnvApiKey(options.provider);
}

function resolveEndpointUrl(options: LLMOptions): string | undefined {
	if (options.provider === "together") {
		return options.endpointUrl || TOGETHER_DEFAULT_BASE_URL;
	}
	if (options.provider === "openrouter") {
		return options.endpointUrl || OPENROUTER_DEFAULT_BASE_URL;
	}
	if (options.provider === "vllm") {
		return options.endpointUrl || readEnvString("VLLM_BASE_URL");
	}
	return options.endpointUrl;
}

export function resolveProviderRuntimeConfig(
	options: LLMOptions,
): ProviderRuntimeConfig {
	if (
		options.openrouterProvider !== undefined &&
		(typeof options.openrouterProvider !== "string" ||
			!options.openrouterProvider.trim())
	) {
		throw new Error("openrouterProvider must be a non-empty string.");
	}
	if (
		options.openrouterProvider !== undefined &&
		options.provider !== "openrouter"
	) {
		throw new Error(
			"openrouterProvider can only be used with provider 'openrouter'.",
		);
	}
	const providerDefinition = getProviderDefinition(options.provider);
	const apiKey = resolveApiKey(options);
	const endpointUrl = resolveEndpointUrl(options);

	if (providerDefinition.requiresApiKey && !apiKey) {
		throw new Error(
			`Missing API key for provider '${options.provider}'. Set the matching environment variable.`,
		);
	}
	if (options.provider === "vllm" && !endpointUrl) {
		throw new Error(
			"Provider 'vllm' requires endpointUrl in LLM options or VLLM_BASE_URL in the environment.",
		);
	}

	return {
		provider: options.provider,
		adapter: providerDefinition.adapter,
		apiKey,
		endpointUrl,
	};
}

function buildLanguageModel(options: {
	model: string;
	runtimeConfig: ProviderRuntimeConfig;
}) {
	if (options.runtimeConfig.adapter === "openrouter") {
		return createOpenRouter({
			apiKey: options.runtimeConfig.apiKey!,
			baseURL: options.runtimeConfig.endpointUrl,
			compatibility: "strict",
		})(options.model, buildOpenRouterModelSettings());
	}
	if (options.runtimeConfig.adapter === "openai-compatible") {
		if (!options.runtimeConfig.endpointUrl) {
			throw new Error(
				`Provider '${options.runtimeConfig.provider}' requires endpointUrl.`,
			);
		}
		return createOpenAICompatible({
			name: `${options.runtimeConfig.provider}`,
			baseURL: options.runtimeConfig.endpointUrl,
			apiKey: options.runtimeConfig.apiKey || "EMPTY",
		}).chatModel(options.model);
	}
	if (options.runtimeConfig.adapter === "anthropic") {
		return createAnthropic({ apiKey: options.runtimeConfig.apiKey! })(
			options.model,
		);
	}
	if (options.runtimeConfig.adapter === "google") {
		return createGoogleGenerativeAI({
			apiKey: options.runtimeConfig.apiKey!,
		})(options.model);
	}
	return createOpenAI({
		apiKey: options.runtimeConfig.apiKey!,
		...(options.runtimeConfig.endpointUrl
			? { baseURL: options.runtimeConfig.endpointUrl }
			: {}),
	})(options.model);
}

function stripThinkBlocks(content: string): {
	cleanContent: string;
	reasoningTokens: string;
} {
	const reasoningParts: string[] = [];
	let stripped = content;

	stripped = stripped.replace(
		/<think\b[^>]*>([\s\S]*?)<\/think>/gi,
		(_match, inner: string) => {
			if (inner.trim()) {
				reasoningParts.push(inner.trim());
			}
			return "";
		},
	);

	const closingTagMatch = stripped.match(/<\/think>/i);
	if (closingTagMatch && closingTagMatch.index !== undefined) {
		const reasoningPrefix = stripped.slice(0, closingTagMatch.index).trim();
		if (reasoningPrefix) {
			reasoningParts.push(reasoningPrefix);
		}
		stripped = stripped.slice(
			closingTagMatch.index + closingTagMatch[0].length,
		);
	}

	const danglingOpenMatch = stripped.match(/<think\b[^>]*>/i);
	if (danglingOpenMatch && danglingOpenMatch.index !== undefined) {
		const reasoningSuffix = stripped
			.slice(danglingOpenMatch.index + danglingOpenMatch[0].length)
			.trim();
		if (reasoningSuffix) {
			reasoningParts.push(reasoningSuffix);
		}
		stripped = stripped.slice(0, danglingOpenMatch.index);
	}

	return {
		cleanContent: stripped.trim(),
		reasoningTokens: reasoningParts.join("\n").trim(),
	};
}

function normalizeReasoningToString(reasoning: ReasoningOutput[]): string {
	if (!reasoning || reasoning.length === 0) {
		return "";
	}

	return reasoning
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function toTokenUsage(usage: LanguageModelUsage): TokenUsage {
	const inputTokens =
		typeof usage?.inputTokens === "number"
			? usage.inputTokens
			: typeof (usage as any)?.promptTokens === "number"
				? (usage as any).promptTokens
				: 0;
	const totalOutputTokens =
		typeof usage?.outputTokens === "number"
			? usage.outputTokens
			: typeof (usage as any)?.completionTokens === "number"
				? (usage as any).completionTokens
				: 0;
	const reasoningTokens =
		typeof usage?.outputTokenDetails?.reasoningTokens === "number"
			? usage.outputTokenDetails.reasoningTokens
			: typeof usage?.reasoningTokens === "number"
				? usage.reasoningTokens
				: undefined;
	const nonReasoningOutputTokens =
		typeof usage?.outputTokenDetails?.textTokens === "number"
			? usage.outputTokenDetails.textTokens
			: typeof reasoningTokens === "number"
				? Math.max(0, totalOutputTokens - reasoningTokens)
				: undefined;
	const cachedInputTokens =
		typeof usage?.inputTokenDetails?.cacheReadTokens === "number"
			? usage.inputTokenDetails.cacheReadTokens
			: typeof usage?.cachedInputTokens === "number"
				? usage.cachedInputTokens
				: 0;
	const totalTokens =
		typeof usage?.totalTokens === "number"
			? usage.totalTokens
			: inputTokens + totalOutputTokens;

	return {
		input_tokens: inputTokens,
		cached_input_tokens: cachedInputTokens,
		reasoning_tokens: reasoningTokens,
		non_reasoning_output_tokens: nonReasoningOutputTokens,
		output_tokens: totalOutputTokens,
		total_tokens: totalTokens,
	};
}

export function __toTokenUsageForTests(usage: LanguageModelUsage): TokenUsage {
	return toTokenUsage(usage);
}

function buildProviderOptions(params: {
	model: string;
	provider: Provider;
	reasoningEffort: NonNullable<LLMOptions["reasoningEffort"]>;
	openrouterProvider?: string;
}) {
	if (params.provider === "openai") {
		const uses24HourPromptCacheRetention =
			params.model === "gpt-5.5" || params.model === "gpt-5.5-pro";
		return {
			openai: {
				include_usage: true,
				reasoningSummary: "detailed",
				reasoningEffort: params.reasoningEffort,
				...(uses24HourPromptCacheRetention
					? { promptCacheRetention: "24h" as const }
					: {}),
			},
		};
	}

	const capability = getReasoningModelCapability(
		params.provider,
		params.model,
	);
	if (params.provider === "vllm") {
		const enabled = params.reasoningEffort === "enabled";
		return {
			vllm: {
				include_usage: true,
				...(capability?.model === "qwen"
					? {
							chat_template_kwargs: {
								enable_thinking: enabled,
							},
						}
					: {
							reasoning: { enabled: false },
							chat_template_kwargs: {
								enable_thinking: false,
								thinking: false,
							},
						}),
			},
		};
	}

	if (params.provider === "together") {
		if (params.reasoningEffort === "none") {
			return {
				together: {
					include_usage: true,
					reasoning: { enabled: false },
					chat_template_kwargs: {
						enable_thinking: false,
						thinking: false,
					},
				},
			};
		}
		return {
			together: {
				include_usage: true,
				reasoningEffort: params.reasoningEffort,
			},
		};
	}

	if (params.provider === "openrouter") {
		return {
			openrouter: {
				reasoning: { effort: params.reasoningEffort },
				...(params.openrouterProvider
					? {
							provider: {
								only: [params.openrouterProvider.trim()],
								allow_fallbacks: false,
							},
						}
					: {}),
			},
		};
	}

	return {
		openai: {
			include_usage: true,
			reasoningSummary: "detailed",
		},
		vllm: {
			include_usage: true,
			chat_template_kwargs: {
				enable_thinking: true,
			},
		},
	};
}

async function runProviderChatInternal(args: ProviderChatArgs): Promise<{
	content: string;
	usage: TokenUsage;
	reasoning_tokens: string;
}> {
	validateReasoningConfiguration(args.options);
	const runtimeConfig = resolveProviderRuntimeConfig(args.options);
	const model = buildLanguageModel({
		model: args.options.model,
		runtimeConfig,
	});
	const isVLLMProvider = args.options.provider === "vllm";

	const providerOptions = buildProviderOptions({
		model: args.options.model,
		provider: args.options.provider,
		reasoningEffort: args.options.reasoningEffort!,
		openrouterProvider: args.options.openrouterProvider,
	});

	if (args.onOutputChunk || args.onLifecycleEvent) {
		let firstDeltaEmitted = false;
		let firstTextDeltaEmitted = false;
		const streamed = streamText({
			model: model as any,
			prompt: args.prompt,
			abortSignal: args.abortSignal,
			temperature: isVLLMProvider ? 0.2 : undefined,
			onChunk: ({ chunk }) => {
				if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") {
					return;
				}
				if (!firstDeltaEmitted) {
					firstDeltaEmitted = true;
					args.onLifecycleEvent?.({
						type: "first_delta",
						deltaType: chunk.type === "text-delta" ? "text" : "reasoning",
					});
				}
				if (chunk.type === "text-delta" && !firstTextDeltaEmitted) {
					firstTextDeltaEmitted = true;
					args.onLifecycleEvent?.({ type: "first_text_delta" });
				}
			},
			providerOptions: providerOptions as unknown as NonNullable<
				Parameters<typeof streamText>[0]["providerOptions"]
			>,
		});
		const chunks: string[] = [];
		for await (const chunk of streamed.textStream) {
			console.log(chunk)
			chunks.push(chunk);
			args.onOutputChunk?.(chunk);
		}
		args.onLifecycleEvent?.({
			type: "text_stream_complete",
			chunkCount: chunks.length,
			outputCharacters: chunks.reduce(
				(total, chunk) => total + chunk.length,
				0,
			),
		});
		const [usage, streamedReasoning] = await Promise.all([
			streamed.usage,
			streamed.reasoning,
		]);
		args.onLifecycleEvent?.({ type: "usage_complete" });
		const { cleanContent, reasoningTokens } = stripThinkBlocks(chunks.join(""));
		const mergedReasoningTokens = [
			normalizeReasoningToString(streamedReasoning ?? []),
			reasoningTokens,
		]
			.filter((value) => value.length > 0)
			.join("\n")
			.trim();
		return {
			content: cleanContent || "{}",
			usage: toTokenUsage(usage),
			reasoning_tokens: mergedReasoningTokens,
		};
	}

	const generated = await generateText({
		model: model as any,
		prompt: args.prompt,
		abortSignal: args.abortSignal,
		temperature: isVLLMProvider ? 0.2 : undefined,
		providerOptions: providerOptions as unknown as NonNullable<
			Parameters<typeof generateText>[0]["providerOptions"]
		>,
	});

	const usage = await generated.usage;
	const { cleanContent, reasoningTokens } = stripThinkBlocks(generated.text);
	const mergedReasoningTokens = [
		normalizeReasoningToString(generated.reasoning ?? []),
		reasoningTokens,
	]
		.filter((value) => value.length > 0)
		.join("\n")
		.trim();
	return {
		content: cleanContent || "{}",
		usage: toTokenUsage(usage),
		reasoning_tokens: mergedReasoningTokens,
	};
}

export function __setProviderChatOverrideForTests(
	override:
		| ((args: ProviderChatArgs) => Promise<{
				content: string;
				usage: TokenUsage;
				reasoning_tokens: string;
		  }>)
		| null,
): void {
	providerChatOverride = override;
}

export function __setProviderOverrideForTests(
	provider: Provider,
	override:
		| ((args: ProviderChatArgs) => Promise<{
				content: string;
				usage: TokenUsage;
				reasoning_tokens: string;
		  }>)
		| null,
): void {
	perProviderOverrides.set(provider, override);
}

export function __buildProviderOptionsForTests(params: {
	model: string;
	provider: Provider;
	reasoningEffort: NonNullable<LLMOptions["reasoningEffort"]>;
	openrouterProvider?: string;
}) {
	validateReasoningConfiguration({
		provider: params.provider,
		model: params.model,
		reasoningEffort: params.reasoningEffort,
	});
	return buildProviderOptions(params);
}

export function __buildOpenRouterModelSettingsForTests() {
	return buildOpenRouterModelSettings();
}

export async function runProviderChat(args: ProviderChatArgs): Promise<{
	content: string;
	usage: TokenUsage;
	reasoning_tokens: string;
}> {
	const providerOverride = perProviderOverrides.get(args.options.provider);
	if (providerOverride) {
		return await providerOverride(args);
	}
	if (providerChatOverride) {
		return await providerChatOverride(args);
	}
	return await runProviderChatInternal(args);
}

function getOpenAIClient(): OpenAI {
	if (openaiClient) {
		return openaiClient;
	}
	const apiKey = readEnvString("OPENAI_API_KEY");
	if (!apiKey) {
		throw new Error(
			"Missing OPENAI_API_KEY for token counting. Set OPENAI_API_KEY in the environment.",
		);
	}
	openaiClient = new OpenAI({ apiKey });
	return openaiClient;
}

export function __setOpenAIClientForTests(client: OpenAI | null): void {
	openaiClient = client;
}

export async function countInputTokensOpenAI(input: {
	model: string;
	payload: unknown;
}): Promise<number> {
	const res = await getOpenAIClient().responses.inputTokens.count({
		model: input.model,
		input: input.payload as any,
	});
	return res.input_tokens ?? 0;
}
