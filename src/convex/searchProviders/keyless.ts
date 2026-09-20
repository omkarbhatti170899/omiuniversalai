import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";

const DUCK_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * Keyless last-resort engine. Always "configured" so Omi Search can still
 * reach the live web even if SearXNG and every other source fail — lower
 * quality, but it keeps the feature alive at zero cost.
 */
export function createKeylessProvider(): SearchProvider {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo (keyless)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults): Promise<SearchProviderResult> {
      const res = await axios.post(
        DUCK_ENDPOINT,
        new URLSearchParams({ q: query }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          },
          timeout: 20000,
        },
      );

      const html = String(res.data ?? "");
      const results: WebCitation[] = [];

      const linkRe =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe =
        /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

      const snippets: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = snippetRe.exec(html)) !== null) {
        snippets.push(sm[1].replace(/<[^>]+>/g, "").trim());
      }

      let lm: RegExpExecArray | null;
      let i = 0;
      while ((lm = linkRe.exec(html)) !== null && results.length < numResults) {
        let url = lm[1];
        // DDG wraps URLs in a redirect (uddg param) — unwrap it.
        const match = url.match(/uddg=([^&]+)/);
        if (match) url = decodeURIComponent(match[1]);
        if (!url.startsWith("http")) continue;

        const title = lm[2].replace(/<[^>]+>/g, "").trim();
        results.push({
          title: (title || url).slice(0, 300),
          url,
          snippet: snippets[i] ? snippets[i].slice(0, 600) : undefined,
        });
        i += 1;
      }

      if (results.length === 0) {
        throw new MissingKeyError("duckduckgo");
      }
      return { citations: results };
    },
  };
}
