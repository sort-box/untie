import { useAuth } from "@clerk/tanstack-react-start";
import { ConvexQueryClient } from "@convex-dev/react-query";
import { ConvexProviderWithClerk } from "convex/react-clerk";

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL;
const convexQueryClient = CONVEX_URL
	? new ConvexQueryClient(CONVEX_URL)
	: undefined;

export default function AppConvexProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	if (!convexQueryClient) return children;

	return (
		<ConvexProviderWithClerk
			client={convexQueryClient.convexClient}
			useAuth={useAuth}
		>
			{children}
		</ConvexProviderWithClerk>
	);
}
