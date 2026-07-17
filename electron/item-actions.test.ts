import { describe, expect, it, vi } from "vitest";

const { createItemActions } = require("./item-actions.cjs");

function setup({ openResult = "", missing = false } = {}) {
	const shell = {
		openPath: vi.fn().mockResolvedValue(openResult),
		showItemInFolder: vi.fn(),
	};
	const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
	const fsApi = {
		statSync: vi.fn(() => {
			if (missing) throw missingError;
			return {};
		}),
	};
	const actions = createItemActions({ shell, fsApi });
	const input = { itemId: "opaque-item-id" };
	const context = {
		authorization: { item: { canonicalPath: "/canonical/file.txt" } },
	};
	return { actions, context, fsApi, input, shell };
}

describe("opaque item actions", () => {
	it("opens the authorized canonical path and reports success", async () => {
		const { actions, context, input, shell } = setup();

		await expect(actions.openItem(input, context)).resolves.toEqual({
			opened: true,
		});
		expect(shell.openPath).toHaveBeenCalledWith("/canonical/file.txt");
		expect(shell.openPath).not.toHaveBeenCalledWith(input.itemId);
	});

	it("reports a safe failure when Electron cannot open the item", async () => {
		const { actions, context, input, shell } = setup({
			openResult: "No application can open this item",
		});

		await expect(actions.openItem(input, context)).resolves.toEqual({
			opened: false,
		});
		expect(shell.openPath).toHaveBeenCalledWith("/canonical/file.txt");
	});

	it("reveals the authorized canonical path", () => {
		const { actions, context, input, shell } = setup();

		expect(actions.revealItem(input, context)).toEqual({ revealed: true });
		expect(shell.showItemInFolder).toHaveBeenCalledWith("/canonical/file.txt");
		expect(shell.showItemInFolder).not.toHaveBeenCalledWith(input.itemId);
	});

	it.each([
		"openItem",
		"revealItem",
	])("rejects a missing file before calling the shell for %s", async (action) => {
		const { actions, context, input, shell } = setup({ missing: true });

		await expect(
			Promise.resolve().then(() => actions[action](input, context)),
		).rejects.toMatchObject({ code: "STALE_REFERENCE" });
		expect(shell.openPath).not.toHaveBeenCalled();
		expect(shell.showItemInFolder).not.toHaveBeenCalled();
	});
});
