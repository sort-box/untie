# R3 — FTS5 relevance and extraction spike

Date: 2026-07-16

## Decision

**Go** on the PRD §7.1/§7.2 find architecture: keep a local SQLite FTS5 index, retrieve approximately 20 candidates, then let the LLM rerank that bounded shortlist. Use the FTS5 `porter unicode61 remove_diacritics 2` tokenizer, AND-combine safely quoted terms, append `*` for prefix matching, and rank with `bm25` weights favoring filename over path and content.

The spike's acceptance target was the PRD success criterion (the relevant document in the top three) with local retrieval p95 below 50 ms on a roughly 5,000-file index. The selected strategy achieved a 100% top-three rate on both metadata and content labels and a worst measured p95 of 0.14 ms. This is ample headroom for an on-disk database, structured filters, and snippet generation.

## Binding choice

Use Node's built-in `node:sqlite` `DatabaseSync`, not `better-sqlite3`.

The FTS5 probe succeeded (`CREATE VIRTUAL TABLE ... USING fts5`) using the SQLite bundled with the installed Node runtime, and FTS5 availability plus the full benchmark were re-confirmed on the **Node 22.x line (22.22.1)** — the runtime that matters for the Electron 43 product path, not only on the newer Node used for the headline numbers below. `node:sqlite` entered Node in 22.5.0, satisfies the Node 22 test constraint, and avoids a native addon, ABI rebuilds, and another Electron packaging/signing input. It should remain isolated behind an index adapter because the API was still release-candidate maturity in the Node 22 line; if the Electron-embedded Node version lacks FTS5, the fallback is `better-sqlite3`, not a change to the index schema or retrieval design.

## Method

The deterministic generator creates 5,000 records across realistic nested areas such as Downloads, School, Work, Finance, Travel, and Personal. It varies names, dates, sizes, and ten extensions. Of those records, 311 have extractable content across PDF, DOCX, TXT, and Markdown. Sixteen labeled queries cover:

- six filename/path-oriented metadata queries;
- six content-oriented natural-language queries;
- two deliberately truncated metadata queries; and
- two content morphology variants.

Each strategy builds separate metadata and content FTS tables in an in-memory SQLite database. Every labeled query is timed 30 times after index construction. Quality is reported as mean reciprocal rank (MRR), precision at 3, recall at 20, and top-three success. There is one relevant document per query, so the maximum conventional precision@3 is 0.333.

Run the reproducible benchmark with:

```sh
bun run spike:r3
```

The command uses Node's type-stripping runner, not Bun APIs. Tests run through Vitest and exercise deterministic generation, query construction, retrieval, and extraction round trips.

## Retrieval results

Measured on an Apple Silicon development machine with Node v26.5.0 and bundled SQLite 3.53.3. Latencies are per query over the 5,000-row index; values will vary by machine. The retrieval-quality numbers reproduce and p95 stays in the same sub-0.15 ms band on the Node 22.x line (22.22.1) that matches the Electron 43 product runtime, so the go decision does not depend on the newer Node version.

| Strategy | Dataset | MRR | P@3 | Recall@20 | Top 3 | Mean ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Unicode61 + AND | Metadata | 0.750 | 0.250 | 0.750 | 75.0% | 0.013 | 0.025 | 0.057 |
| Unicode61 + AND | Content | 0.750 | 0.250 | 0.750 | 75.0% | 0.011 | 0.015 | 0.045 |
| Unicode61 + prefix AND | Metadata | 1.000 | 0.333 | 1.000 | 100% | 0.079 | 0.134 | 0.144 |
| Unicode61 + prefix AND | Content | 0.875 | 0.292 | 0.875 | 87.5% | 0.081 | 0.107 | 0.119 |
| **Porter + prefix AND** | **Metadata** | **1.000** | **0.333** | **1.000** | **100%** | **0.078** | **0.139** | **0.152** |
| **Porter + prefix AND** | **Content** | **1.000** | **0.333** | **1.000** | **100%** | **0.085** | **0.110** | **0.135** |
| Porter + OR | Metadata | 1.000 | 0.333 | 1.000 | 100% | 0.068 | 0.321 | 0.339 |
| Porter + OR | Content | 1.000 | 0.333 | 1.000 | 100% | 0.012 | 0.014 | 0.030 |

Porter + OR scored equally on this label set, but it is not the default: OR broadens common-term queries, produces a less selective shortlist, and had the highest metadata tail latency. The selected AND query is predictable; the future query interpreter can explicitly request OR/fallback behavior when an AND query returns too few candidates.

## Extraction throughput

Extraction reads generated files from disk sequentially and includes file-read overhead. The byte rate uses actual fixture bytes, not synthetic metadata sizes.

| Format | Files | Total ms | Files/s | MB/s |
|---|---:|---:|---:|---:|
| TXT | 83 | 5.20 | 15,958 | 0.74 |
| Markdown | 75 | 4.26 | 17,591 | 0.82 |
| PDF | 91 | 7.25 | 12,545 | 7.81 |
| DOCX | 62 | 4.05 | 15,293 | 5.28 |

These are deliberately small, text-native fixtures, so files/second is primarily a fixed-overhead measurement and must not be projected to a user's large documents. The spike extractor handles UTF-8 text, text-showing operators in generated text PDFs, and the OOXML `word/document.xml` entry (stored or deflated). It is reusable for this corpus and evaluation work, but it is **not** the production parser decision: it does not handle arbitrary PDF encodings, scanned PDFs, encrypted/corrupt files, or the full DOCX surface. F13/index implementation should benchmark production parser candidates against real, mixed-size documents and enforce the PRD's size caps and timeouts.

## Architecture consequences and follow-ups

- Store name, path, extension, and extracted content as separately weighted FTS columns; keep opaque file ID unindexed.
- Generate MATCH expressions from tokenized structured query terms. Never pass raw user FTS syntax through to SQLite.
- Use Porter stemming plus Unicode61 diacritic folding and prefix terms. Start with AND; use a controlled OR fallback only when recall is empty/too small.
- Retrieve 20 rows ordered by BM25, with filename weighted above path and content. Apply structured extension/date filters outside or alongside MATCH.
- Keep extraction asynchronous, bounded, and failure-tolerant; metadata-only indexing remains the fallback for unsupported, placeholder, corrupt, protected, or timed-out documents.
- Expand the labeled set from 16 synthetic queries to the PRD target of about 30 real dogfood queries in F13. Add distractors sharing several query terms and report per-query failures so perfect aggregate results are not mistaken for production validation.

The spike therefore clears FTS5 relevance and latency as architectural risks. Robust production extraction and representative real-document evaluation remain implementation work, not reasons to change the local FTS5 → top-20 → LLM rerank design.
