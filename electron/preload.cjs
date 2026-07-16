const { contextBridge, ipcRenderer } = require("electron");
const { capabilityNames } = require("./capabilities/contracts.cjs");
const {
	CANCEL_CHANNEL,
	INVOKE_CHANNEL,
} = require("./capabilities/registry.cjs");

let nextRequestId = 0;

function invoke(capability, input, options = {}) {
	const requestId = `renderer-${++nextRequestId}`;
	if (options.signal?.aborted) {
		return Promise.resolve({
			ok: false,
			error: { code: "CANCELLED", message: "Request was cancelled" },
		});
	}

	const cancel = () => ipcRenderer.send(CANCEL_CHANNEL, requestId);
	options.signal?.addEventListener("abort", cancel, { once: true });
	return ipcRenderer
		.invoke(INVOKE_CHANNEL, { requestId, capability, input })
		.finally(() => options.signal?.removeEventListener("abort", cancel));
}

const capabilities = Object.fromEntries(
	capabilityNames.map((name) => [
		name,
		(input, options) => invoke(name, input, options),
	]),
);

contextBridge.exposeInMainWorld("untie", Object.freeze(capabilities));
contextBridge.exposeInMainWorld(
	"desktop",
	Object.freeze({ platform: process.platform, isElectron: true }),
);
