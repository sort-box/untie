import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { initializeLocalStores } = require("./local-store.cjs");
const {
	createFolderGrantService,
	createGrantStore,
} = require("./grant-store.cjs");
const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
} = require("./capabilities/authorization.cjs");

let root: string;
let folder: string;

function openService(showOpenDialog = vi.fn(), fsApi = fs) {
	const local = initializeLocalStores(path.join(root, "stores"));
	const referenceStore = new CapabilityReferenceStore();
	const service = createFolderGrantService({
		store: createGrantStore(local.stores.grants.directory),
		referenceStore,
		showOpenDialog,
		fsApi,
		now: () => 1_721_177_600_000,
		randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
	});
	return { service, referenceStore };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-grants-test-"));
	folder = path.join(root, "Selected");
	fs.mkdirSync(folder);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("persistent folder grants", () => {
	it("selects with the directory-only system picker and survives relaunch", async () => {
		const picker = vi
			.fn()
			.mockResolvedValue({ canceled: false, filePaths: [folder] });
		const first = openService(picker);
		const selected = await first.service.selectFolder();

		expect(picker).toHaveBeenCalledWith({ properties: ["openDirectory"] });
		expect(selected).toEqual({
			grantId: "grant_0123456789abcdef0123456789abcdef",
		});

		const relaunched = openService();
		expect(relaunched.service.restore()).toEqual([
			{
				grantId: selected.grantId,
				state: "active",
				createdAt: 1_721_177_600_000,
			},
		]);
		expect(
			createCapabilityAuthorizer({
				store: relaunched.referenceStore,
			}).resolveGrant(selected.grantId).canonicalPath,
		).toBe(fs.realpathSync.native(folder));
	});

	it("returns a typed cancellation without persisting a grant", async () => {
		const { service } = openService(
			vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
		);
		await expect(service.selectFolder()).resolves.toEqual({ grantId: null });
		expect(service.listGrants()).toEqual({ grants: [] });
	});

	it("surfaces a missing grant instead of dropping it", async () => {
		const first = openService(
			vi.fn().mockResolvedValue({ canceled: false, filePaths: [folder] }),
		);
		const { grantId } = await first.service.selectFolder();
		fs.rmSync(folder, { recursive: true });

		const relaunched = openService();
		expect(relaunched.service.restore()).toEqual([
			{ grantId, state: "missing", createdAt: 1_721_177_600_000 },
		]);
		expect(() =>
			createCapabilityAuthorizer({
				store: relaunched.referenceStore,
			}).resolveGrant(grantId),
		).toThrowError(expect.objectContaining({ code: "STALE_REFERENCE" }));
	});

	it("surfaces identity replacement as moved", async () => {
		const first = openService(
			vi.fn().mockResolvedValue({ canceled: false, filePaths: [folder] }),
		);
		const { grantId } = await first.service.selectFolder();
		fs.rmdirSync(folder);
		fs.mkdirSync(folder);

		expect(openService().service.restore()).toEqual([
			{ grantId, state: "moved", createdAt: 1_721_177_600_000 },
		]);
	});

	it("surfaces a TCC-style readability denial as revoked", async () => {
		const first = openService(
			vi.fn().mockResolvedValue({ canceled: false, filePaths: [folder] }),
		);
		const { grantId } = await first.service.selectFolder();
		const deniedFs = {
			...fs,
			accessSync: () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			},
		};

		expect(openService(vi.fn(), deniedFs).service.restore()).toEqual([
			{ grantId, state: "revoked", createdAt: 1_721_177_600_000 },
		]);
	});

	it("persists revocation and rejects the grant after relaunch", async () => {
		const first = openService(
			vi.fn().mockResolvedValue({ canceled: false, filePaths: [folder] }),
		);
		const { grantId } = await first.service.selectFolder();
		expect(first.service.revokeGrant({ grantId })).toEqual({ revoked: true });
		expect(first.service.revokeGrant({ grantId })).toEqual({ revoked: false });

		const relaunched = openService();
		expect(relaunched.service.restore()[0]).toMatchObject({
			grantId,
			state: "revoked",
		});
		expect(() =>
			createCapabilityAuthorizer({
				store: relaunched.referenceStore,
			}).resolveGrant(grantId),
		).toThrowError(expect.objectContaining({ code: "REVOKED_GRANT" }));
	});
});
