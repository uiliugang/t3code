# Work item drafts

Checks the production draft generator for language preservation, explicit constraints, unknown delivery facts and instructions embedded in source material. It imports `makeCodexTextGeneration`, which uses the production prompt and output schema. Cases are synthetic and traceable to the requirements redesign.

From `evals/`, run `pnpm work-item-drafts --model <configured-model> --out runs/drafts`. Start with `--case chinese-requirements --samples 1`; the full run defaults to three samples per case. Add `--baseline runs/earlier/results.json` for blinded comparison. Score `review.json` against its rubrics before opening `answer-key.json`; a case fails when at least half its samples fail. Add cases in `cases.ts` with a source and a rubric.

The full run makes nine paid model calls. Cost depends on the configured provider; the CLI does not report billing, so the summary records that limitation. Use the cheapest configured model that supports structured output. Results remain in the ignored `runs/` directory.
