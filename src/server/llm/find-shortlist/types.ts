export type FindShortlistConfidence = "high" | "medium" | "low";

export interface FindShortlistCandidate {
	itemId: string;
	displayName: string;
	snippet: string;
}

export interface RankFindShortlistInput {
	query: {
		searchTerms: string[];
		query: string;
	};
	candidates: FindShortlistCandidate[];
}

export interface FindShortlistSelection {
	itemId: string;
	matchReason: string;
	confidence: FindShortlistConfidence;
}

export type FindShortlistResult =
	| {
			status: "ranked";
			selections: FindShortlistSelection[];
	  }
	| {
			status: "no_match";
			selections: [];
	  };

export interface FindShortlistModelOutput {
	selections: FindShortlistSelection[];
	noMatch: boolean;
}
