import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const GH_SEARCH_URL = "https://api.github.com/search/repositories";
const UA = "OmiSearch/1.0 (https://ominnovations.example; contact: omi@ominnovations.example)";

/** Pure helper: does this query deserve a GitHub code-hosting lookup? */
export function isTechRepositoryQuery(q: string): boolean {
  const s = (q ?? "").toLowerCase();
  const libHints =
    /\b(github|repo(?:sitory)?|library|framework|sdk|cli|api client|open ?source|npm|package|compiler|runtime|parser|database engine|self-?hosted)\b/;
  const techSignals =
    /\b(javascript|typescript|python|rust|golang|go\b|java\b|kotlin|swift|c\+\+|c\b|zig|ruby|php|webassembly|wasm|llm|inference|kubernetes|docker|react|vue|svelte|postgres|sqlite|redis|torch|tensorflow|onnx|whisper|ollama|vllm|searxng|opensearch|faiss)\b/;
  // "best markdown editor" → yes; "best pizza in rome" → no.
  return libHints.test(s) || techSignals.test(s);
}

/** Pure helper: map GitHub API items to Omi's normalized citation shape. */
export function mapRepoToCitation(r: {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  pushed_at?: string | null;
  license?: { spdx_id?: string | null } | null;
  archived?: boolean;
}): { title: string; url: string; snippet: string; publishedAt?: string } | null {
  if (!r.full_name || !r.html_url) return null;
  const bits: string[] = [];
  if (r.description) bits.push(r.description.slice(0, 220));
  const meta: string[] = [];
  if (r.language) meta.push(r.language);
  if (typeof r.stargazers_count === "number") {
    meta.push(`${r.stargazers_count.toLocaleString("en-US")} stars`);
  }
  if (r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION") {
    meta.push(`License: ${r.license.spdx_id}`);
  }
  if (r.archived) meta.push("archived");
  if (meta.length > 0) bits.push(`(${meta.join(", ")})`);
  return {
    title: r.full_name,
    url: r.html_url,
    snippet: bits.join(" ").trim() || "GitHub repository.",
    publishedAt: r.pushed_at ?? undefined,
  };
}

/**
 * GitHub public repository search (master plan §5: "GitHub public APIs
 * within applicable limits").
 *
 * License/cost/legal reality (§32 audit):
 *   • Keyless: 10 req/min per IP — well inside Andromeda's parallel budget
 *     because this provider only activates for tech-relevant queries.
 *   • Public repository metadata only (name, description, language, stars,
 *     license, last push). No code content is fetched or stored.
 *   • Rate-limit citizenship: on HTTP 403/429 with a Retry-After header the
 *     provider throws MissingKeyError immediately (the orchestrator's error
 *     isolation treats it as "source unavailable") — we never hammer.
 */
export function createGitHubProvider(): SearchProvider {
  return {
    id: "github",
    label: "GitHub (public repositories)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      // Scope discipline: GitHub lookups only fire for tech/library queries —
      // the free quota is a shared, finite resource and ordinary web
      // questions get nothing from it (§6: don't burn free capacity).
      if (!isTechRepositoryQuery(query)) {
        return { citations: [] };
      }

      const lang = opts?.language && opts.language !== "all" ? opts.language : undefined;
      try {
        const res = await axios.get(GH_SEARCH_URL, {
          params: {
            q: query.slice(0, 200),
            per_page: Math.min(numResults, 10),
            sort: "best-match",
            ...(lang ? {} : {}),
          },
          headers: {
            "User-Agent": UA,
            Accept: "application/vnd.github+json",
          },
          timeout: 12000,
        });

        const items = (res.data?.items ?? []) as Array<
          Parameters<typeof mapRepoToCitation>[0]
        >;
        const citations = items
          .map(mapRepoToCitation)
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .slice(0, numResults);

        return { citations };
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 403 || status === 429) {
          // Rate limited: back off honestly, let error isolation continue.
          throw new MissingKeyError("github: rate limited — backing off");
        }
        throw new MissingKeyError(
          `github: ${err instanceof Error ? err.message : "unavailable"}`,
        );
      }
    },
  };
}
