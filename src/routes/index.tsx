import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
		<div className="p-8">
			<h1 className="text-4xl font-bold">Untie</h1>
			<p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
				{identityStatus(identity)}
			</p>
		</div>
	);
}

function identityStatus(identity?: CurrentIdentityResult): string {
	if (!identity) return "Verifying account…";
	if (identity.status === "authenticated") return "Account verified";
	if (identity.status === "expired") return "Session expired — sign in again";
	return "Sign in to continue";
}
