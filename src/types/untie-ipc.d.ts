import type { CapabilityClient } from "../../electron/capabilities/contracts.cjs";

declare global {
	interface Window {
		desktop: Readonly<{ platform: string; isElectron: true }>;
		untie: Readonly<CapabilityClient>;
	}
}
