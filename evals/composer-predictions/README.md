# Composer predictions

Checks the shipped prediction generator on synthetic conversations: preserve the user's language, suggest a concrete next message, respect restrictions against publishing, and abstain when no follow-up is supported.

```sh
cd evals
pnpm composer-predictions --model <configured-cheap-codex-model> --out /tmp/t3-prediction-eval
```

The runner uses the current `generatePredictedMessage` operation, your local Codex login, and an isolated temporary checkout. Pass `--codex-binary <path>` to select an installed CLI, `--case <id>` to narrow the run, and `--samples <count>` to change the default three samples per case. Results and a rubric for manual review are written to `results.json`. A case passes when a majority of samples meet its rubric. Structured output and context bounds are covered by unit tests; semantic quality is reviewed here. No fixed cost is assumed: this runs the selected model once per sample and consumes its normal provider usage.
