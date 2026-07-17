import { generateFindCorpus } from "./corpus.ts";
import { evaluateFindCorpus } from "./evaluate.ts";

console.log(JSON.stringify(evaluateFindCorpus(generateFindCorpus()), null, 2));
