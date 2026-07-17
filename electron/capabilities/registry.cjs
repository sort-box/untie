const { capabilityNames, contracts } = require("./contracts.cjs");
const {
	CapabilityAuthorizationError,
	containsRendererPath,
} = require("./authorization.cjs");
const { RiskAcknowledgmentError } = require("../sort-risk.cjs");

const INVOKE_CHANNEL = "untie:capability:invoke";
const CANCEL_CHANNEL = "untie:capability:cancel";
const INDEX_STATUS_CHANNEL = "untie:index-status";

function failure(code, message, details) {
	return {
		ok: false,
		error: { code, message, ...(details === undefined ? {} : { details }) },
	};
}

function createCapabilityRegistry(implementations = {}, authorizer) {
	const activeRequests = new Map();

	async function invoke(_event, envelope) {
		if (
			envelope === null ||
			typeof envelope !== "object" ||
			Array.isArray(envelope) ||
			typeof envelope.requestId !== "string" ||
			typeof envelope.capability !== "string"
		) {
			return failure("INVALID_REQUEST", "Malformed capability envelope");
		}

		const { capability, requestId } = envelope;
		if (!capabilityNames.includes(capability)) {
			return failure("UNKNOWN_CAPABILITY", "Unknown capability", {
				capability,
			});
		}
		if (containsRendererPath(envelope.input)) {
			return failure("PATH_SUPPLIED", "Filesystem paths are not capabilities");
		}
		const parsed = contracts[capability].request(envelope.input);
		if (!parsed.ok) {
			return failure(
				"INVALID_REQUEST",
				"Capability request failed validation",
				{
					capability,
					reason: parsed.message,
				},
			);
		}

		const handler = implementations[capability];
		if (typeof handler !== "function") {
			return failure("NOT_IMPLEMENTED", `${capability} is not available yet`);
		}

		const controller = new AbortController();
		activeRequests.set(requestId, controller);
		try {
			const authorization =
				authorizer?.authorize(capability, parsed.value) ?? {};
			const output = await handler(parsed.value, {
				signal: controller.signal,
				authorization,
			});
			if (controller.signal.aborted) {
				return failure("CANCELLED", "Request was cancelled");
			}
			const response = contracts[capability].response(output);
			return response.ok
				? { ok: true, value: response.value }
				: failure("INVALID_RESPONSE", "Capability response failed validation", {
						capability,
						reason: response.message,
					});
		} catch (error) {
			if (controller.signal.aborted) {
				return failure("CANCELLED", "Request was cancelled");
			}
			if (error instanceof CapabilityAuthorizationError) {
				return failure(error.code, error.message, error.details);
			}
			if (error instanceof RiskAcknowledgmentError) {
				return failure(error.code, error.message);
			}
			return failure("INTERNAL", "Capability failed");
		} finally {
			activeRequests.delete(requestId);
		}
	}

	function cancel(_event, requestId) {
		if (typeof requestId === "string") activeRequests.get(requestId)?.abort();
	}

	return { invoke, cancel };
}

function registerCapabilityHandlers(ipcMain, implementations, authorizer) {
	const registry = createCapabilityRegistry(implementations, authorizer);
	ipcMain.handle(INVOKE_CHANNEL, registry.invoke);
	ipcMain.on(CANCEL_CHANNEL, registry.cancel);
	return () => {
		ipcMain.removeHandler(INVOKE_CHANNEL);
		ipcMain.removeListener(CANCEL_CHANNEL, registry.cancel);
	};
}

module.exports = {
	CANCEL_CHANNEL,
	INDEX_STATUS_CHANNEL,
	INVOKE_CHANNEL,
	createCapabilityRegistry,
	registerCapabilityHandlers,
};
