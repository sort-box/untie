import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { StartupStatus } from "../../electron/capabilities/contracts.cjs";
import { ChatWorkspace } from "../components/chat/chat-workspace";
import {
	type CurrentIdentityResult,
	getCurrentIdentity,
} from "../server/auth/current-identity";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	const [identity, setIdentity] = useState<CurrentIdentityResult>();
	const [startup, setStartup] = useState<StartupStatus>();

	useEffect(() => {
		void getCurrentIdentity().then(setIdentity);
		if (window.desktop?.isElectron) {
			void window.untie.getStartupStatus({}).then((result) => {
				if (result.ok) setStartup(result.value);
			});
		} else {
			setStartup({
				status: "recovered",
				reasons: [],
				recoveredBatchCount: 0,
				needsAttentionCount: 0,
			});
		}
	}, []);

	const gateBlocked =
		!identity ||
		!startup ||
		identity.status !== "authenticated" ||
		startup.status !== "recovered";

	return (
		<div className="flex h-dvh flex-col">
			<header className="flex items-center justify-between gap-4 px-6 py-4">
				<h1 className="display-title font-semibold text-2xl text-foreground">
					Untie
				</h1>
				<p
					className="rounded-full border border-border bg-[color:var(--chip-bg)] px-3 py-1 text-muted-foreground text-xs"
					aria-live="polite"
				>
					{identityStatus(identity)}
				</p>
			</header>
			<main className="flex min-h-0 w-full flex-1 justify-center px-6 pb-6">
				<div className="flex min-h-0 w-full max-w-5xl">
					{gateBlocked ? (
						<output className="m-auto block max-w-lg text-center">
							<h2 className="font-semibold text-xl">Startup checks</h2>
							<p className="mt-2 text-muted-foreground">
								{startupMessage(identity, startup)}
							</p>
						</output>
					) : (
						<ChatWorkspace />
					)}
				</div>
			</main>
		</div>
	);
}

function startupMessage(
	identity?: CurrentIdentityResult,
	startup?: StartupStatus,
): string {
	if (!identity || !startup) return "Checking your local data and account…";
	if (identity.status === "expired")
		return "Your session expired. Sign in again to continue.";
	if (identity.status === "unauthorized") return "Sign in to continue.";
	if (startup.reasons.includes("unavailable_grant"))
		return "One or more folder grants are unavailable and need your attention.";
	if (startup.reasons.includes("journal_needs_attention"))
		return "A previous file operation needs your attention before Untie can continue.";
	return "Untie could not complete its startup checks safely.";
}

function identityStatus(identity?: CurrentIdentityResult): string {
	if (!identity) return "Verifying account…";
	if (identity.status === "authenticated") return "Account verified";
	if (identity.status === "expired") return "Session expired — sign in again";
	return "Sign in to continue";
}
