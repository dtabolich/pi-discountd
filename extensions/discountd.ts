/**
 * discountd - the discount daemon. Always watching for the next deal.
 *
 * `or` (OpenRouter) is the default - and currently only - source. Future
 * provider members (anthropic, bedrock, ...) slot in behind the same command
 * as additional sources.
 *
 *   /discountd            🔥 Deal of the Day + coding-focused deals
 *   /discountd or         OpenRouter deals (the default source)
 *   /discountd all        All discounted models, sorted by discount
 *   /discountd free       Free coding-capable models ($0 tokens)
 *   /discountd cheap      Cheapest paid coding models
 *   /discountd pick       Pick a model from the deals list and activate it
 *   /discountd pick <id>  Activate a specific deal model by slug (no picker)
 *   /discountd refresh    Force-refresh the cached data
 *
 * Data comes from OpenRouter's frontend models API
 * (https://openrouter.ai/api/frontend/v1/models/find). The `?discount=true`
 * filter returns exactly the entries with promotional pricing (the same
 * list behind the "Discounted AI Models" collection).
 *
 * Coding relevance is classified from OpenRouter's "programming" usage
 * analytics (per-model category volume/rank) plus slug/name heuristics.
 *
 * `pick` activates a deal model in the current pi session:
 *   - if the model already exists in pi's model registry (e.g. an open-weight
 *     deal you already have configured), it is set directly;
 *   - otherwise, if OPENROUTER_API_KEY is set, the model is registered as an
 *     OpenRouter provider model on the fly and activated;
 *   - otherwise you get a hint on how to configure the key.
 */

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MODELS_FIND_URL = "https://openrouter.ai/api/frontend/v1/models/find";
const MESSAGE_TYPE = "discountd";
const UA = "pi-discountd/0.1 (pi extension; contact: user)";

const CACHE_DIR = join(homedir(), ".cache", "pi-discountd");
const DEALS_TTL_MS = 6 * 60 * 60 * 1000; // discounted list is small + volatile
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // full catalog is ~5MB, static-ish
const FETCH_TIMEOUT_MS = 20_000;

// --- Types ---------------------------------------------------------------

interface Pricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  discount?: number;
}

interface Endpoint {
  provider_display_name?: string;
  provider_slug?: string;
  variant?: string;
  is_free?: boolean;
  max_completion_tokens?: number;
  pricing?: Pricing;
}

interface ModelEntry {
  slug: string;
  permaslug?: string;
  name?: string;
  description?: string;
  context_length?: number;
  endpoint?: Endpoint;
}

interface CategoryStat {
  date?: string;
  category?: string;
  count?: number;
  volume?: number;
  rank?: number;
}

interface CatalogPayload {
  models?: ModelEntry[];
  categories?: Record<string, CategoryStat[]>;
}

interface CacheEntry<T> {
  fetchedAt: number;
  data: T;
}

// --- Coding classification ------------------------------------------------

const CODING_RE =
  /(coder|codex|codestral|devstral|kat-coder|grok-build|swe-|-swe|ox-alpha|sol-pro|code-latest|\bcode\b|nemotron|laguna|coding)/i;

function codingSignal(slug: string, name: string, perm: string | undefined, categories: Record<string, CategoryStat[]>): { coding: boolean; volume: number; rank: number } {
  const hay = `${slug} ${name}`.toLowerCase();
  const heuristic = CODING_RE.test(hay);
  let volume = 0;
  let rank = 0;
  if (perm) {
    for (const e of categories[perm] ?? []) {
      if (e.category === "programming") {
        volume = e.volume ?? 0;
        rank = e.rank ?? 0;
      }
    }
  }
  // Analytics (top-usage programming signal) trumps heuristics both ways:
  // a clearly general model with heavy coding usage counts as coding, and a
  // model with zero usage analytics falls back to the name heuristic.
  const coding = heuristic || volume > 1 || (rank > 0 && rank <= 60);
  return { coding, volume, rank };
}

// --- Cache ----------------------------------------------------------------

function loadCache<T>(name: string): CacheEntry<T> | null {
  try {
    const raw = readFileSync(join(CACHE_DIR, name), "utf8");
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

function saveCache<T>(name: string, data: T): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, name), JSON.stringify({ fetchedAt: Date.now(), data }), "utf8");
  } catch {
    // cache is best-effort
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the discounted models list, cached. */
async function getDeals(force: boolean): Promise<{ payload: CatalogPayload; stale: boolean }> {
  const cached = loadCache<CatalogPayload>("deals.json");
  if (!force && cached && Date.now() - cached.fetchedAt < DEALS_TTL_MS) {
    return { payload: cached.data, stale: false };
  }
  const raw = await fetchJson<{ data: CatalogPayload }>(`${MODELS_FIND_URL}?discount=true&limit=2000`);
  saveCache("deals.json", raw.data);
  return { payload: raw.data, stale: false };
}

/** Returns the full model catalog, cached. Used for free + cheap lists. */
async function getCatalog(force: boolean): Promise<{ payload: CatalogPayload; stale: boolean }> {
  const cached = loadCache<CatalogPayload>("catalog.json");
  if (!force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return { payload: cached.data, stale: false };
  }
  const raw = await fetchJson<{ data: CatalogPayload }>(`${MODELS_FIND_URL}?limit=2000`);
  saveCache("catalog.json", raw.data);
  return { payload: raw.data, stale: false };
}

// --- Formatting -----------------------------------------------------------

function perM(num: number | undefined): string {
  if (num === undefined || Number.isNaN(num)) return "?";
  const m = num * 1e6; // API prices are per-token USD
  if (m === 0) return "$0";
  if (m < 0.01) return `$${(m * 1000).toFixed(2)}/K`;
  if (m < 0.1) return `$${m.toFixed(3)}/M`;
  if (m < 1) return `$${m.toFixed(2)}/M`;
  return `$${m.toFixed(1)}/M`;
}

function fmtPrice(p: Pricing | undefined, key: "prompt" | "completion"): string {
  const raw = p?.[key];
  return perM(raw ? parseFloat(raw) : undefined);
}

function classifyCoding(m: ModelEntry, categories: Record<string, CategoryStat[]>) {
  return codingSignal(m.slug, m.name ?? m.slug, m.permaslug ?? m.slug, categories);
}

function renderDeals(payload: CatalogPayload, codingOnly: boolean): string {
  const categories = payload.categories ?? {};
  const models = payload.models ?? [];
  // One row per model: among its discounted endpoints, keep the cheapest.
  const byModel = new Map<
    string,
    { disc: number; coding: boolean; prompt: number; slug: string; provider: string; in: string; out: string; line: string }
  >();

  for (const m of models) {
    const ep = m.endpoint;
    const disc = ep?.pricing?.discount ?? 0;
    if (disc <= 0) continue;
    const { coding } = classifyCoding(m, categories);
    if (codingOnly && !coding) continue;

    const provider =
      `${ep?.provider_display_name ?? "?"}${ep?.variant && ep.variant !== "standard" ? " (" + ep.variant + ")" : ""}`;
    const prompt = ep?.pricing?.prompt ? parseFloat(ep.pricing.prompt) : Infinity;
    const inP = fmtPrice(ep?.pricing, "prompt");
    const outP = fmtPrice(ep?.pricing, "completion");
    const line = `| ${coding ? "code" : "gen"} | ${Math.round(disc * 100)}% | ${m.slug} | ${provider} | ${inP} | ${outP} |`;

    const existing = byModel.get(m.slug);
    // Prefer the biggest discount; tie-break by cheapest input price.
    if (!existing || disc > existing.disc || (disc === existing.disc && prompt < existing.prompt)) {
      byModel.set(m.slug, { disc, coding, prompt, slug: m.slug, provider, in: inP, out: outP, line });
    }
  }

  const rows = [...byModel.values()].sort((a, b) => b.disc - a.disc || a.prompt - b.prompt);
  const spotlight = rows[0]
    ? `🔥 **Deal of the Day** - ${Math.round(rows[0].disc * 100)}% off **${rows[0].slug}** (${rows[0].provider}) · ${rows[0].in} in / ${rows[0].out} out\n\n`
    : "";
  const header =
    "| type | off | model | provider | in | out |\n" +
    "|------|-----|-------|----------|-----|-----|\n";
  return spotlight + header + rows.map((r) => r.line).join("\n");
}

function renderFree(payload: CatalogPayload): string {
  const categories = payload.categories ?? {};
  const rows: Array<{ coding: boolean; vol: number; line: string }> = [];

  for (const m of payload.models ?? []) {
    if (!m.endpoint?.is_free) continue;
    const { coding, volume } = classifyCoding(m, categories);
    rows.push({
      coding,
      vol: volume,
      line: `| ${coding ? "code" : "gen"} | ${m.slug} | ${m.name ?? ""} |`,
    });
  }

  // Free endpoints all cost $0; show coding-capable models first, ranked by
  // observed programming usage, then the rest alphabetically.
  rows.sort(
    (a, b) =>
      b.coding === a.coding ? b.vol - a.vol || a.line.localeCompare(b.line) : Number(b.coding) - Number(a.coding),
  );
  const header = "| type | model (free :free variant) | name |\n|------|---------------------------|------|\n";
  return header + rows.map((r) => r.line).join("\n");
}

function renderCheap(payload: CatalogPayload): string {
  const categories = payload.categories ?? {};
  const rows: Array<{ in: number; line: string }> = [];

  for (const m of payload.models ?? []) {
    const ep = m.endpoint;
    if (!ep || ep.is_free) continue;
    const { coding } = classifyCoding(m, categories);
    if (!coding) continue;
    const input = ep.pricing?.prompt ? parseFloat(ep.pricing.prompt) : undefined;
    if (input === undefined) continue;
    rows.push({
      in: input,
      line: `| ${m.slug} | ${ep.provider_display_name ?? "?"} | ${fmtPrice(ep.pricing, "prompt")} | ${fmtPrice(ep.pricing, "completion")} |`,
    });
  }

  rows.sort((a, b) => a.in - b.in);
  const header = "| model | provider | in | out |\n|-------|----------|-----|-----|\n";
  return header + rows.slice(0, 25).map((r) => r.line).join("\n");
}

// --- Model activation -------------------------------------------------------

interface RegistryModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
}

function parseCost(price: string | undefined): number {
  return price ? parseFloat(price) : 0;
}

/** Build a pi model registration for an OpenRouter deal model (on-the-fly). */
function toProviderModelConfig(m: ModelEntry): ProviderModelConfig {
  const ep = m.endpoint;
  const p = ep?.pricing ?? {};
  return {
    id: m.slug,
    name: m.name ?? m.slug,
    reasoning: true,
    input: ["text"] as const,
    cost: {
      input: parseCost(p.prompt),
      output: parseCost(p.completion),
      cacheRead: parseCost(p.input_cache_read),
      cacheWrite: 0,
    },
    contextWindow: m.context_length ?? 128000,
    maxTokens: ep?.max_completion_tokens ?? 8192,
  };
}

/**
 * Resolve a deal model slug against pi's current model registry.
 * Matches `provider/id` (e.g. deepseek-v4-flash under the deepseek provider
 * matches the OpenRouter slug `deepseek/deepseek-v4-flash`) and bare ids.
 */
async function findRegistryModel(ctx: ExtensionCommandContext, slug: string): Promise<RegistryModel | undefined> {
  try {
    const available = await ctx.modelRegistry.getAvailable();
    const direct = available.find((m) => `${m.provider}/${m.id}` === slug || m.id === slug);
    if (direct) {
      return {
        id: direct.id,
        name: direct.name,
        provider: direct.provider,
        contextWindow: direct.contextWindow,
        maxTokens: direct.maxTokens,
      };
    }
  } catch {
    // registry may be unavailable in some contexts
  }
  return undefined;
}

/** Register the picked model as an OpenRouter provider model and activate it. */
async function activateViaOpenRouter(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  m: ModelEntry,
): Promise<boolean> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return false;
  }
  pi.registerProvider("openrouter", {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "$OPENROUTER_API_KEY",
    api: "openai-completions",
    models: [toProviderModelConfig(m)],
  });
  const model = ctx.modelRegistry.find("openrouter", m.slug);
  if (!model) return false;
  return pi.setModel(model);
}

/** Present the deals list as a picker and activate the chosen model. */
async function pickDealModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  payload: CatalogPayload,
  requested: string | undefined,
): Promise<void> {
  const categories = payload.categories ?? {};
  const models = (payload.models ?? []).filter((m) => (m.endpoint?.pricing?.discount ?? 0) > 0);

  // Resolve availability for every deal model up front so the picker can show it.
  const avail = new Map<string, boolean>();
  for (const m of models) {
    avail.set(m.slug, (await findRegistryModel(ctx, m.slug)) !== undefined);
  }

  const describe = (m: ModelEntry): string => {
    const ep = m.endpoint;
    const disc = Math.round((ep?.pricing?.discount ?? 0) * 100);
    const { coding } = classifyCoding(m, categories);
    const mark = avail.get(m.slug) ? "ACTIVE" : "needs OpenRouter key";
    return `${coding ? "[code]" : "[gen]"} ${disc}% off ${m.slug} (${ep?.provider_display_name ?? "?"}) ${fmtPrice(ep?.pricing, "prompt")}/${fmtPrice(ep?.pricing, "completion")} - ${mark}`;
  };

  const pick = async (m: ModelEntry): Promise<void> => {
    const existing = await findRegistryModel(ctx, m.slug);
    if (existing) {
      const model = ctx.modelRegistry.find(existing.provider, existing.id);
      if (model && (await pi.setModel(model))) {
        ctx.ui.notify(`Switched to ${existing.provider}/${existing.id}`, "info");
        return;
      }
      ctx.ui.notify(`Model found but activation failed (no API key?)`, "error");
      return;
    }
    if (await activateViaOpenRouter(pi, ctx, m)) {
      ctx.ui.notify(`Switched to OpenRouter: ${m.slug}`, "info");
      return;
    }
    ctx.ui.notify(
      `${m.slug} isn't in your registry and OpenRouter isn't configured. ` +
        "Set OPENROUTER_API_KEY (or add it to ~/.pi/agent/auth.json), then retry.",
      "error",
    );
  };

  if (requested) {
    const match = models.find((m) => m.slug.includes(requested) || (m.name ?? "").toLowerCase().includes(requested.toLowerCase()));
    if (!match) {
      ctx.ui.notify(`No deal model matches "${requested}". Try /discountd pick with no args.`, "warning");
      return;
    }
    await pick(match);
    return;
  }

  if (models.length === 0) {
    ctx.ui.notify("No discounted models to pick from.", "warning");
    return;
  }

  const items = models.map(describe);
  const selected = await ctx.ui.select("Pick a deal model to activate", items);
  if (!selected) return;
  const idx = items.indexOf(selected);
  if (idx >= 0) await pick(models[idx]);
}
// --- Extension ------------------------------------------------------------

export default function discountdExtension(pi: ExtensionAPI) {
  // Keep deal output visible in the TUI but out of the LLM's context.
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (m) => !(m.role === "custom" && (m as { customType?: string }).customType === MESSAGE_TYPE),
    );
    if (filtered.length !== event.messages.length) return { messages: filtered };
  });

  pi.registerCommand("discountd", {
    description: "The discount daemon: hot-swap discounted models into your session",
    getArgumentCompletions: (prefix) => {
      const opts = ["or", "coding", "all", "free", "cheap", "pick", "refresh"];
      const filtered = opts.filter((o) => o.startsWith((prefix ?? "").toLowerCase()));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const cmd = tokens[0] || "coding";
      const rest = tokens.slice(1).join(" ");
      const force = cmd === "refresh";
      const view = force ? "coding" : cmd;
      const codingOnly = view !== "all" && view !== "free" && view !== "cheap";
      const emit = (title: string, body: string, stale: boolean) => {
        const stamp = stale ? " (stale cache - refresh failed)" : "";
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: `## /discountd ${stamp}\n${body}\n\n_Data: openrouter.ai - run \`/discountd refresh\` to update._`,
          display: true,
        });
        if (force) ctx.ui.notify(title, "info");
      };

      try {
        if (view === "free") {
          ctx.ui.notify("Fetching free models...", "info");
          const { payload, stale } = await getCatalog(force);
          const body = renderFree(payload);
          emit("Free coding models", body, stale);
          return;
        }
        if (view === "cheap") {
          ctx.ui.notify("Fetching cheapest coding models...", "info");
          const { payload, stale } = await getCatalog(force);
          const body = renderCheap(payload);
          emit("Cheapest coding models", body, stale);
          return;
        }
        if (view === "pick") {
          ctx.ui.notify("Fetching OpenRouter deals...", "info");
          const { payload } = await getDeals(force);
          await pickDealModel(pi, ctx, payload, rest || undefined);
          return;
        }
        // default: deals
        ctx.ui.notify("Fetching OpenRouter deals...", "info");
        const { payload, stale } = await getDeals(force);
        const body = renderDeals(payload, codingOnly);
        emit(codingOnly ? "Coding deals" : "All deals", body, stale);
      } catch (err) {
        // Fall back to stale cache so the command still works offline.
        const cachedDeals = loadCache<CatalogPayload>("deals.json");
        const cachedCatalog = loadCache<CatalogPayload>("catalog.json");
        if (view === "free" && cachedCatalog) {
          emit("Cached free models (offline)", renderFree(cachedCatalog.data), true);
          return;
        }
        if (view === "cheap" && cachedCatalog) {
          emit("Cached cheapest models (offline)", renderCheap(cachedCatalog.data), true);
          return;
        }
        if (cachedDeals) {
          emit("Cached deals (offline)", renderDeals(cachedDeals.data, codingOnly), true);
          return;
        }
        ctx.ui.notify(`discountd failed: ${(err as Error).message}`, "error");
      }
    },
  });
}
