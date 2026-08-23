# pi-discountd

🔥 **The discount daemon for pi - always watching for the next deal.**

Hot-swap discounted models into your session with one command. `discountd`
reads OpenRouter's live discount feed, pins the **Deal of the Day** at the top,
and lets you pick any model to activate instantly.

```
🔥 Deal of the Day - 90% off upstage/solar-pro4 (Upstage) · $0.030/M in / $0.12/M out

| type | off  | model                | provider | in       | out    |
|------|------|----------------------|----------|----------|--------|
| code | 90%  | upstage/solar-pro4   | Upstage  | $0.030/M | $0.12/M |
| code | 77%  | deepseek/deepseek-v4-pro | StreamLake | $0.40/M | $0.79/M |
| ...  |      |                      |          |          |        |
```

## Install

```bash
pi install npm:pi-discountd
```

Requires no API key for the deal listings. Activating OpenRouter-only models
(via `pick`) needs an OpenRouter API key.

## Usage

| Command | What it does |
|---|---|
| `/discountd` | 🔥 Deal of the Day + coding-focused deals |
| `/discountd or` | OpenRouter deals (the default source) |
| `/discountd all` | All discounted models, sorted by discount |
| `/discountd free` | Free models ($0 tokens) |
| `/discountd cheap` | Cheapest paid coding models |
| `/discountd pick` | Pick a model from the deals and activate it |
| `/discountd pick <id>` | Activate a specific deal model by slug |
| `/discountd refresh` | Force-refresh the cache |

## How it works

- Reads OpenRouter's frontend models API (`?discount=true`) - the same
  promotional-discount list behind the "Discounted AI Models" collection.
- Classifies coding models from OpenRouter's per-model "programming" usage
  analytics plus slug/name heuristics.
- Caches locally (deals 6h, full catalog 24h); works offline on stale cache.
- `pick` activates a model three ways:
  1. already in your pi registry → set directly
  2. not in registry + OpenRouter key set → registered on the fly and activated
  3. otherwise → hints at how to configure the key

## Scope

`or` (OpenRouter) is the default - and currently only - source. Future
provider members (`anthropic`, `bedrock`, ...) can slot in behind the same
command as additional sources.

## License

MIT
