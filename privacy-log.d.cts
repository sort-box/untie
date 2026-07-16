export type SafeLogMetadata = Record<string, unknown>;
export interface PrivacyLogger {
	log(level: "info" | "warn" | "error", event: string, metadata?: SafeLogMetadata): void;
	reportCrash(event: string, error: unknown, metadata?: SafeLogMetadata): void;
}
export function redactSensitiveText(value: unknown): unknown;
export function allowlistedMetadata(metadata: unknown): Record<string, unknown>;
export function createPrivacyLogger(write?: (line: string) => void): PrivacyLogger;
export const privacyLogger: PrivacyLogger;
