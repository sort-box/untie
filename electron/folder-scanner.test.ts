import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
	FolderScanCancelledError,
	createFolderScanner,
}: {
	FolderScanCancelledError: new () => Error & { code: "CANCELLED" };
	createFolderScanner: (options: { appDataDirectory: string }) => {
		scanFolder: (
			folder: string,
			options?: { signal?: AbortSignal },
		) => Promise<{
			files: { name: string; size: number }[];
			candidateDestinations: { name: string }[];
			skipped: { name: string; reason: string }[];
		}>;
	};
} = require("./folder-scanner.cjs");

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
	const directory = await mkdtemp(path.join(tmpdir(), "untie-scan-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("safe top-level folder scanner", () => {
	it("classifies representative top-level entries without descending", async () => {
		const folder = await temporaryDirectory();
		const appDataDirectory = path.join(folder, "Untie Data");
		await mkdir(appDataDirectory);
		await writeFile(path.join(appDataDirectory, "index.sqlite"), "private");
		await writeFile(path.join(folder, "report.pdf"), "report");
		await writeFile(path.join(folder, ".secret"), "hidden");
		await writeFile(path.join(folder, "video.crdownload"), "partial");
		await writeFile(path.join(folder, "archive.part"), "partial");
		await symlink("report.pdf", path.join(folder, "report alias"));
		await mkdir(path.join(folder, "Example.app"));
		await writeFile(path.join(folder, "Example.app", "executable"), "binary");
		await mkdir(path.join(folder, "School"));
		await writeFile(path.join(folder, "School", "nested.txt"), "nested");

		const scanner = createFolderScanner({ appDataDirectory });
		const result = await scanner.scanFolder(folder);

		expect(result).toEqual({
			files: [{ name: "report.pdf", size: 6 }],
			candidateDestinations: [{ name: "School" }],
			skipped: [
				{ name: ".secret", reason: "HIDDEN" },
				{ name: "archive.part", reason: "TEMPORARY_DOWNLOAD" },
				{ name: "Example.app", reason: "PACKAGE_BUNDLE" },
				{ name: "report alias", reason: "SYMLINK_OR_ALIAS" },
				{ name: "Untie Data", reason: "APP_DATA" },
				{ name: "video.crdownload", reason: "TEMPORARY_DOWNLOAD" },
			],
		});
		expect(JSON.stringify(result)).not.toContain("nested.txt");
		expect(JSON.stringify(result)).not.toContain(folder);
	});

	it("discards work and reports typed cancellation", async () => {
		const folder = await temporaryDirectory();
		const appDataDirectory = await temporaryDirectory();
		await writeFile(path.join(folder, "report.pdf"), "report");
		const controller = new AbortController();
		controller.abort();

		const scanner = createFolderScanner({ appDataDirectory });
		const scan = scanner.scanFolder(folder, { signal: controller.signal });

		await expect(scan).rejects.toBeInstanceOf(FolderScanCancelledError);
		await expect(scan).rejects.toMatchObject({ code: "CANCELLED" });
	});
});
