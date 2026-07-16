export type FindDateRange = {
	after: string | null;
	before: string | null;
};

export type FindQueryInterpretation =
	| {
			status: "ready";
			searchTerms: string[];
			filters: {
				extensions: string[];
				namePatterns: string[];
				modifiedAt: FindDateRange | null;
			};
			clarification: string | null;
	  }
	| {
			status: "needs_clarification";
			searchTerms: [];
			filters: {
				extensions: [];
				namePatterns: [];
				modifiedAt: null;
			};
			clarification: string;
	  };

export type InterpretFindQueryInput = { query: string };
