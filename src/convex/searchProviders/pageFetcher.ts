/**
 * Page retrieval & extraction for citations. Given a result URL, fetches
 * the page and extracts readable text so Omi can ground answers in full
 * page content instead of just the search snippet. Zero-cost: direct
 * fetch with a browser-like UA, HTML stripped locally.
 *
 * Uses streaming with a byte cap so huge pages (e.g. long Wikipedia
 * articles) are truncated cleanly instead of throwing.
 */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MAX_BYTES = 1_500_000; // streamed cap — we stop reading past this
const TIMEOUT_MS = 15_000;

/** Strip HTML to readable text without external dependencies. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
}

export type ExtractedPage = {
  url: string;
  title: string;
  text: string; // readable text, trimmed to maxChars
  ok: boolean;
  error?: string;
};

export async function fetchPageText(
  url: string,
  maxChars = 4000,
): Promise<ExtractedPage> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });

    if (!res.ok) {
      return { url, title: "", text: "", ok: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      return { url, title: "", text: "", ok: false, error: "non-HTML content" };
    }

    // Stream the body and stop once we have enough bytes — never blow up
    // on a multi-megabyte page.
    let html = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let received = 0;
      let truncated = false;
      while (!truncated) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (received >= MAX_BYTES) {
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            // reader already closed — fine
          }
        }
      }
      html += decoder.decode(); // flush
    } else {
      html = await res.text();
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : "";

    // Prefer the main content area when the page has one.
    const articleMatch =
      html.match(/<article[\s\S]*?<\/article>/i) ??
      html.match(/<main[\s\S]*?<\/main>/i);
    const body = articleMatch ? articleMatch[0] : html;

    const text = htmlToText(body).slice(0, maxChars);
    if (text.length < 80) {
      return { url, title, text, ok: false, error: "too little text" };
    }
    return { url, title: title || url, text, ok: true };
  } catch (err) {
    return {
      url,
      title: "",
      text: "",
      ok: false,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}
