import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatWorkspace } from "../components/chat/chat-workspace";
import {
	type CurrentIdentityResult,
	getCurrentIdentity,
} from "../server/auth/current-identity";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	const [identity, setIdentity] = useState<CurrentIdentityResult>();

	useEffect(() => {
		void getCurrentIdentity().then(setIdentity);
	}, []);

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
					<ChatWorkspace />
				</div>
			</main>
		</div>
	);
}

function identityStatus(identity?: CurrentIdentityResult): string {
	if (!identity) return "Verifying account…";
	if (identity.status === "authenticated") return "Account verified";
	if (identity.status === "expired") return "Session expired — sign in again";
	return "Sign in to continue";
}
