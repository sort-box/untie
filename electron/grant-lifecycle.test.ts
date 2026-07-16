import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	CapabilityReferenceStore,
} = require("./capabilities/authorization.cjs");
const { createGrantLifecycle } = require("./grant-lifecycle.cjs");

describe("grant lifecycle side effects", () => {
	it.each([
		"missing",
		"moved",
		"revoked",
	])("stops watching and removes index membership for %s grants", (state) => {
		const referenceStore = new CapabilityReferenceStore();
		referenceStore.setPlan({
			id: "plan-1",
			grantId: "grant-1",
			grantRevision: 1,
			status: "active",
		});
		const watcher = { reconcileGrant: vi.fn() };
		const indexSync = { removeGrant: vi.fn() };
		const lifecycle = createGrantLifecycle({
			watcher,
			referenceStore,
			indexSync,
		});
		const grant = { grantId: "grant-1", state };

		lifecycle.handleStateChange(grant);

		expect(watcher.reconcileGrant).toHaveBeenCalledWith(grant);
		expect(indexSync.removeGrant).toHaveBeenCalledWith("grant-1");
		expect(referenceStore.getPlan("plan-1").status).toBe(
			state === "revoked" ? "invalidated" : "active",
		);
	});

	it("invalidates every opaque item, prepared plan, and operation on revocation", () => {
		const referenceStore = new CapabilityReferenceStore();
		referenceStore.setItem({
			id: "item-1",
			grantId: "grant-1",
			status: "active",
		});
		referenceStore.setPlan({
			id: "plan-1",
			grantId: "grant-1",
			status: "active",
		});
		referenceStore.setOperation({
			id: "operation-1",
			grantId: "grant-1",
			status: "active",
		});
		const lifecycle = createGrantLifecycle({
			watcher: { reconcileGrant: vi.fn() },
			referenceStore,
			indexSync: { removeGrant: vi.fn() },
		});

		lifecycle.handleStateChange({ grantId: "grant-1", state: "revoked" });

		expect(referenceStore.getItem("item-1").status).toBe("invalidated");
		expect(referenceStore.getPlan("plan-1").status).toBe("invalidated");
		expect(referenceStore.getOperation("operation-1").status).toBe(
			"invalidated",
		);
	});
});
