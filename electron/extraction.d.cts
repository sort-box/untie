export type ExtractionMetadataReason =
	| "unsupported"
	| "too-large"
	| "timeout"
	| "corrupt"
	| "password-protected"
	| "parser-error"
	| "read-error";

export type ExtractionResult =
	| { status: "extracted"; text: string; truncated: boolean }
	| { status: "metadata-only"; reason: ExtractionMetadataReason };

export interface ExtractionLimits {
	maxFileBytes?: number;
	maxTextBytes?: number;
	timeoutMs?: number;
}

export const DEFAULT_EXTRACTION_LIMITS: Readonly<Required<ExtractionLimits>>;
export const SUPPORTED_EXTENSIONS: ReadonlySet<string>;
export function extractFile(
	filename: string,
	options?: ExtractionLimits,
): Promise<ExtractionResult>;
export function truncateUtf8(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean };
