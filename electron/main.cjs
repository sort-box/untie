const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { registerCapabilityHandlers } = require("./capabilities/registry.cjs");
const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
} = require("./capabilities/authorization.cjs");
const { initializeLocalStores } = require("./local-store.cjs");
const { initializeFileIndex } = require("./index-store.cjs");
const { createIndexSynchronizationEngine } = require("./index-sync.cjs");
const { createChatStore } = require("./chat-store.cjs");
const { createFolderScanner } = require("./folder-scanner.cjs");
const { createOpaqueFileRegistry } = require("./opaque-file-registry.cjs");
const {
	createRiskAcknowledgmentStore,
	createSortRiskService,
} = require("./sort-risk.cjs");
const {
	createFolderGrantService,
	createGrantStore,
} = require("./grant-store.cjs");

const DEV_URL = process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:3000";
const PRODUCTION_PORT = 3210;

let productionServer;
let unregisterCapabilityHandlers;
let fileIndex;
let chatStore;
let folderGrantService;
let folderScanner;
let opaqueFileRegistry;
let indexSyncEngine;
let sortRiskService;
const capabilityReferenceStore = new CapabilityReferenceStore();
const capabilityAuthorizer = createCapabilityAuthorizer({
	store: capabilityReferenceStore,
});

function requireChatStore() {
	if (!chatStore) throw new Error("The chat store is not initialized.");
	return chatStore;
}

const capabilityImplementations = {
	ping: async ({ message }) => ({ message }),
	cancellableDelay: ({ milliseconds }, { signal }) =>
		new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => resolve({ completed: true }),
				milliseconds,
			);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timeout);
					reject(new Error("cancelled"));
				},
				{ once: true },
			);
		}),
	listChatSessions: async () => requireChatStore().listSessions(),
	loadChatSession: async ({ sessionId }) =>
		requireChatStore().loadSession(sessionId),
	saveChatSession: async ({ session }) =>
		requireChatStore().saveSession(session),
	deleteChatSession: async ({ sessionId }) =>
		requireChatStore().deleteSession(sessionId),
	deleteAllChatData: async () => requireChatStore().deleteAll(),
	selectFolder: async () => folderGrantService.selectFolder(),
	listFolderGrants: async () => folderGrantService.listGrants(),
	revokeFolderGrant: async (input) => folderGrantService.revokeGrant(input),
	scanFolder: async (_input, { signal, authorization }) => {
		const scan = await folderScanner.scanFolder(
			authorization.grant.canonicalPath,
			{ signal },
		);
		return {
			...scan,
			files: opaqueFileRegistry.registerScan({
				grant: authorization.grant.grant,
				canonicalGrantPath: authorization.grant.canonicalPath,
				files: scan.files,
			}),
		};
	},
	classifyFolderRisk: async ({ grantId }, { signal, authorization }) =>
		sortRiskService.classify({
			grantId,
			canonicalPath: authorization.grant.canonicalPath,
			signal,
		}),
	acknowledgeFolderRisk: async (input) => sortRiskService.acknowledge(input),
};

const contentTypes = {
	".css": "text/css; charset=utf-8",
	".ico": "image/x-icon",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
};

function serveStaticFile(requestPath, response) {
	const clientRoot = path.join(app.getAppPath(), "dist", "client");
	const relativePath = decodeURIComponent(requestPath).replace(/^\/+/, "");
	const filePath = path.resolve(clientRoot, relativePath);

	if (
		!filePath.startsWith(`${clientRoot}${path.sep}`) ||
		!fs.existsSync(filePath)
	) {
		return false;
	}

	const stat = fs.statSync(filePath);
	if (!stat.isFile()) return false;

	response.writeHead(200, {
		"Content-Type":
			contentTypes[path.extname(filePath)] || "application/octet-stream",
		"Content-Length": stat.size,
	});
	fs.createReadStream(filePath).pipe(response);
	return true;
}

async function startProductionServer() {
	const serverEntry = path.join(
		app.getAppPath(),
		"dist",
		"server",
		"server.js",
	);
	const { default: handler } = await import(pathToFileURL(serverEntry).href);

	productionServer = http.createServer(async (incoming, outgoing) => {
		try {
			const url = new URL(
				incoming.url || "/",
				`http://127.0.0.1:${PRODUCTION_PORT}`,
			);

			if (
				(incoming.method === "GET" || incoming.method === "HEAD") &&
				serveStaticFile(url.pathname, outgoing)
			) {
				return;
			}

			const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
			const request = new Request(url, {
				method: incoming.method,
				headers: incoming.headers,
				body: hasBody ? Readable.toWeb(incoming) : undefined,
				...(hasBody ? { duplex: "half" } : {}),
			});
			const response = await handler.fetch(request);

			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			if (!response.body) {
				outgoing.end();
				return;
			}
			Readable.fromWeb(response.body).pipe(outgoing);
		} catch (error) {
			console.error(error);
			outgoing.writeHead(500);
			outgoing.end("Internal Server Error");
		}
	});

	await new Promise((resolve, reject) => {
		productionServer.once("error", reject);
		productionServer.listen(PRODUCTION_PORT, "127.0.0.1", resolve);
	});

	return `http://127.0.0.1:${PRODUCTION_PORT}`;
}

async function createWindow() {
	const window = new BrowserWindow({
		width: 1180,
		height: 780,
		minWidth: 720,
		minHeight: 520,
		show: false,
		backgroundColor: "#fafafa",
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http://") || url.startsWith("https://")) {
			void shell.openExternal(url);
		}
		return { action: "deny" };
	});

	window.once("ready-to-show", () => window.show());

	const appUrl = app.isPackaged ? await startProductionServer() : DEV_URL;
	await window.loadURL(appUrl);
}

app.whenReady().then(async () => {
	try {
		const storesDirectory = path.join(app.getPath("userData"), "stores");
		const localStores = initializeLocalStores(storesDirectory);
		fileIndex = initializeFileIndex(storesDirectory);
		chatStore = createChatStore(path.join(storesDirectory, "chat", "history"));
		folderGrantService = createFolderGrantService({
			store: createGrantStore(localStores.stores.grants.directory),
			referenceStore: capabilityReferenceStore,
			showOpenDialog: (options) => dialog.showOpenDialog(options),
		});
		const restoredGrants = folderGrantService.restore();
		folderScanner = createFolderScanner({
			appDataDirectory: app.getPath("userData"),
		});
		sortRiskService = createSortRiskService({
			scanner: folderScanner,
			acknowledgmentStore: createRiskAcknowledgmentStore(),
		});
		opaqueFileRegistry = createOpaqueFileRegistry({
			referenceStore: capabilityReferenceStore,
		});
		indexSyncEngine = createIndexSynchronizationEngine({
			index: fileIndex,
			scanner: folderScanner,
			authorizer: capabilityAuthorizer,
		});
		await Promise.allSettled(
			restoredGrants
				.filter((grant) => grant.state === "active")
				.map((grant) => indexSyncEngine.syncGrant(grant.grantId)),
		);
	} catch (error) {
		console.error("Untie could not open its local stores.", error);
		dialog.showErrorBox(
			"Untie could not start safely",
			"Your local data could not be opened. Untie did not delete or reset it. Please update or contact support before trying again.",
		);
		app.quit();
		return;
	}
	unregisterCapabilityHandlers = registerCapabilityHandlers(
		ipcMain,
		capabilityImplementations,
		capabilityAuthorizer,
	);
	await createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) void createWindow();
	});
});

app.on("before-quit", () => {
	unregisterCapabilityHandlers?.();
	fileIndex?.database.close();
	fileIndex = undefined;
	chatStore = undefined;
	folderGrantService = undefined;
	folderScanner = undefined;
	sortRiskService = undefined;
	opaqueFileRegistry = undefined;
	indexSyncEngine = undefined;
	productionServer?.close();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
