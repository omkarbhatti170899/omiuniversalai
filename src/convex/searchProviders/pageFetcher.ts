/**
 * Page retrieval & extraction layer (spec §10/§17). Given a result URL:
 *   • validates EVERY hop (initial URL + each redirect) through the SSRF guard
 *   • follows redirects manually with a hard hop limit (no infinite loops)
 *   • respects robots.txt Disallow for our crawler (per-domain memory cache)
 *   • streams the body with a byte cap (huge pages truncate, never throw)
 *   • extracts readable text + title + publication/update metadata
 *
 * A broken website must never freeze Omi: hard timeouts everywhere, and
 * every failure mode returns { ok: false, error } instead of throwing.
 */

import { assertSafeUrl } from "../searchEngine/security";

const UA =
  "Mozilla/5.0 (compatible; OmiResearchBot/1.0; +https://ominnovations.example/bot) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MAX_BYTES = 1_500_000; // streamed cap — we stop reading past this
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;
const ROBOTS_TIMEOUT_MS = 3_000;

/** Strip HTML to readable text without external dependencies. */
export function htmlToText(html: string): string {
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
  url: string; // final URL after redirects
  title: string;
  text: string; // readable text, trimmed to maxChars
  publishedAt?: string; // from meta tags when present
  updatedAt?: string;
  ok: boolean;
  error?: string;
};

// --- robots.txt (per-isolate cache; best-effort per spec §10) --------------

type RobotsRule = { allow: string[]; disallow: string[] };
const robotsCache = new Map<string, { rules: RobotsRule; at: number }>();
const ROBOTS_TTL_MS = 30 * 60_000;

function parseRobots(txt: string): RobotsRule {
  const rules: RobotsRule = { allow: [], disallow: [] };
  let appliesToUs = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      appliesToUs = value === "*";
    } else if (appliesToUs && key === "disallow" && value) {
      rules.disallow.push(value);
    } else if (appliesToUs && key === "allow" && value) {
      rules.allow.push(value);
    }
  }
  return rules;
}

function robotsAllows(rules: RobotsRule, pathname: string): boolean {
  const matches = (pattern: string) => {
    if (pattern === "/") return true; // disallow: / → whole site
    const base = pattern.replace(/\*$/, "");
    return pathname.startsWith(base);
  };
  // Longest-match wins (standard robots semantics, simplified).
  const allowLen = rules.allow.filter(matches).reduce((a, p) => Math.max(a, p.length), -1);
  const disallowLen = rules.disallow.filter(matches).reduce((a, p) => Math.max(a, p.length), -1);
  return allowLen >= disallowLen;
}

async function robotsDisallows(origin: string, pathname: string): Promise<boolean> {
  try {
    const cached = robotsCache.get(origin);
    let rules: RobotsRule;
    if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) {
      rules = cached.rules;
    } else {
      const res = await fetch(origin + "/robots.txt", {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) {
        // No readable robots.txt → not restricted.
        rules = { allow: [], disallow: [] };
      } else {
        rules = parseRobots((await res.text()).slice(0, 64_000));
      }
      robotsCache.set(origin, { rules, at: Date.now() });
    }
    return !robotsAllows(rules, pathname);
  } catch {
    return false; // robots check must never block retrieval
  }
}

// --- Fetch with validated manual redirects ---------------------------------

async function fetchWithGuardedRedirects(
  startUrl: string,
): Promise<{ res: Response; finalUrl: string } | { error: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = assertSafeUrl(current); // SSRF guard on EVERY hop
    } catch (e) {
      return { error: e instanceof Error ? e.message : "unsafe URL" };
    }
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { error: `HTTP ${res.status} redirect without location` };
      try {
        current = new URL(loc, url).toString();
      } catch {
        return { error: "invalid redirect target" };
      }
      continue;
    }
    return { res, finalUrl: url.toString() };
  }
  return { error: `too many redirects (> ${MAX_REDIRECTS})` };
}

export async function fetchPageText(
  url: string,
  maxChars = 4000,
): Promise<ExtractedPage> {
  try {
    const first = assertSafeUrl(url); // validate before any network action
    const origin = first.origin;
    if (await robotsDisallows(origin, first.pathname)) {
      return { url, title: "", text: "", ok: false, error: "blocked by robots.txt" };
    }

    const fetched = await fetchWithGuardedRedirects(first.toString());
    if ("error" in fetched) {
      return { url, title: "", text: "", ok: false, error: fetched.error };
    }
    const { res, finalUrl } = fetched;

    if (!res.ok) {
      return { url: finalUrl, title: "", text: "", ok: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      return { url: finalUrl, title: "", text: "", ok: false, error: "non-HTML content" };
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
      html = (await res.text()).slice(0, MAX_BYTES);
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : "";

    // Publication/update metadata where the page provides it (spec §10).
    const meta = (prop: string) => {
      const m =
        html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i")) ??
        html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i")) ??
        html.match(new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"));
      return m?.[1];
    };
    const publishedAt =
      meta("article:published_time") ?? meta("datePublished") ?? meta("date") ?? undefined;
    const updatedAt =
      meta("article:modified_time") ?? meta("dateModified") ?? undefined;

    // Prefer the main content area when the page has one.
    const articleMatch =
      html.match(/<article[\s\S]*?<\/article>/i) ??
      html.match(/<main[\s\S]*?<\/main>/i);
    const body = articleMatch ? articleMatch[0] : html;

    const text = htmlToText(body).slice(0, maxChars);
    if (text.length < 80) {
      return { url: finalUrl, title, text, publishedAt, updatedAt, ok: false, error: "too little text" };
    }
    return {
      url: finalUrl,
      title: title || finalUrl,
      text,
      publishedAt,
      updatedAt,
      ok: true,
    };
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
