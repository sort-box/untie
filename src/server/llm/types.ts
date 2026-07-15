export type LlmMessageRole = "system" | "user" | "assistant";

export interface LlmMessage {
	role: LlmMessageRole;
	content: string;
}

export type JsonSchema = Record<string, unknown>;

export interface LlmRequest {
	messages: LlmMessage[];
	model?: string;
	maxTokens?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface StructuredLlmRequest<T> extends LlmRequest {
	responseSchema: {
		name: string;
		schema: JsonSchema;
		parse: (value: unknown) => T;
	};
}

export interface LlmUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
}

export interface LlmResult<T> {
	data: T;
	requestId: string;
	model: string;
	finishReason: string | null;
	usage?: LlmUsage;
	cost?: number;
}

export interface LlmService {
	generateText(request: LlmRequest): Promise<LlmResult<string>>;
	generateObject<T>(request: StructuredLlmRequest<T>): Promise<LlmResult<T>>;
}
