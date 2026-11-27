# Text generation models

T3 Code uses an LLM for lightweight background text tasks: thread titles, branch names, commit messages, PR titles/descriptions, and voice transcript cleanup. Configure the default in **Settings → Threads → Text generation model** (overridable separately in **Settings → Source control & issues** and **Settings → Voice**).

To reuse a model and its options across settings, bind a **virtual model** under
**Settings → Providers → Virtual models**, below Text generators. Existing model settings keep
their choices when upgraded. Each feature can follow a virtual model or select a real model
directly. The chat picker lists only real models; a manual pick does not change the binding.

Use the regular settings export and import to transfer these references. The destination keeps
its own binding for the same virtual model. If it cannot match the imported provider and model,
the reference stays unbound. Bind it once on that environment to restore all settings that use
it. An unsent draft keeps its text while you fix the binding.

By default, a coding agent such as Codex or Claude writes this text, starting a session for each
request. A **text generator** — a model API that only writes text — is usually faster and cheaper.

## Add a text generator

Open **Settings → Providers → Text generators → Add generator** (stored per environment; API keys support [Secrets](./secrets.md)):

- **OpenAI** or **Anthropic**: Enter an API key.
- **OpenRouter**: Enter an OpenRouter API key to use any model it serves.
- **Custom (OpenAI-compatible)**: Enter a base URL (e.g. Ollama at `http://localhost:11434/v1` or LM Studio—`localhost` resolves on the environment's server).

Click **Test** beside a model picker to verify the key works, or **Show models** to refresh the catalog. Disabling or removing a generator falls back to the environment's default text generation model.

## Limitations

- **Review guides** always require a coding agent (Codex or Claude), not a text generator—choose one under **Settings → Source control & issues → Review guide model**.
- A [managed policy](./managed-policy.md) that restricts providers also disables text generators.
