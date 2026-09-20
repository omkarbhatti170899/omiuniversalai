import axios from "axios";
import type {
  SearchProvider,
  SearchProviderResult,
  WebCitation,
} from "./exa";

const DUCK_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * Keyless last-resort engine. Always "configured" so Omi Search can still
 * reach the live web even with zero API keys — lower quality than Exa or
 * Tavily, but it keeps the feature alive and always returns citations.
 */
export function createKeylessProvider(): SearchProvider {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo (keyless)",
    missingKeyHint:
      "Add TAVILY_API_KEY or EXA_API_KEY for high-quality AI search. Omi is using its keyless engine meanwhile.",
    isConfigured: () => true,

    async search(query, numResults): Promise<SearchProviderResult> {
      const res = await axios.post(
        DUCK_ENDPOINT,
        new URLSearchParams({ q: query }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          },
          timeout: 20000,
        },
      );

      const html = String(res.data ?? "");
      const results: WebCitation[] = [];

      const linkRe =
        /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe =
        /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

      const snippets: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = snippetRe.exec(html)) !== null) {
        snippets.push(stripHtml(sm[1]));
      }

      let lm: RegExpExecArray | null;
      while ((lm = linkRe.exec(html)) !== null && results.length < numResults) {
        const rawUrl = decodeDuckUrl(lm[1]);
        if (!rawUrl) continue;
        results.push({
          title: stripHtml(lm[2]).slice(0, 200) || rawUrl,
          url: rawUrl,
          snippet: (snippets[results.length] ?? "").slice(0, 400),
        });
      }

      if (results.length === 0) {
        throw new Error(
          "Keyless engine returned no results; try rephrasing your question.",
        );
      }

      return { citations: results };
    },
  };
}

/** DDG html links are /l/?uddg=<encoded real url> — unwrap them. */
function decodeDuckUrl(href: string): string | null {
  try {
    if (href.startsWith("//") || href.startsWith("http")) {
      const abs = href.startsWith("//") ? `https:${href}` : href;
      const u = new URL(abs);
      const target = u.searchParams.get("uddg");
      return target ? decodeURIComponent(target) : abs;
    }
    return null;
  } catch {
    return null;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
