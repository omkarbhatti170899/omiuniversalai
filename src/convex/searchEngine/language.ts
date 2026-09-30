/**
 * QUERY LANGUAGE DETECTION (Phase 3 — universal knowledge layer, minimal step).
 * =============================================================================
 * WHY: the provider layer already accepts `language` (SearXNG `language=`,
 * GitHub topic scoping), but nothing set it from the user's words — so a
 * French query searched with default (English-weighted) settings and the
 * multilingual benchmark row under-performed (5/9).
 *
 * WHAT THIS IS: a script/range detector (Unicode blocks are unambiguous) plus
 * a distinctive-word fallback for Latin-script languages. WHAT IT IS NOT: a
 * full language-ID model — a short query of borrowed words can mislead a
 * statistical classifier, so the word lists are deliberately conservative and
 * everything fails safe to English (today's behaviour) when unsure.
 *
 * PURE and bounded: one pass over the string, no dependencies.
 */

export type QueryLanguage = {
  /** Provider locale code (SearXNG accepts these; BCP-47 subset). */
  code: string;
  /** Human label for traces. */
  label: string;
  /** How it was detected — for observability, not decisions. */
  via: "script" | "words" | "default";
};

/** Unicode script ranges that map directly to a provider locale. */
const SCRIPTS: Array<{ re: RegExp; code: string; label: string }> = [
  { re: /[\u0600-\u06FF]/, code: "ar", label: "Arabic" },
  { re: /[\u0900-\u097F]/, code: "hi", label: "Hindi (Devanagari)" },
  { re: /[\u0980-\u09FF]/, code: "bn", label: "Bengali" },
  { re: /[\u0B80-\u0BFF]/, code: "ta", label: "Tamil" },
  { re: /[\u0C00-\u0C7F]/, code: "te", label: "Telugu" },
  { re: /[\u0A00-\u0A7F]/, code: "pa", label: "Punjabi" },
  { re: /[\u0A80-\u0AFF]/, code: "gu", label: "Gujarati" },
  { re: /[\u3040-\u30FF]/, code: "ja", label: "Japanese" },
  { re: /[\uAC00-\uD7AF\u1100-\u11FF]/, code: "ko", label: "Korean" },
  { re: /[\u4E00-\u9FFF]/, code: "zh", label: "Chinese" },
  { re: /[\u0400-\u04FF]/, code: "ru", label: "Russian" },
  { re: /[\u0E00-\u0E7F]/, code: "th", label: "Thai" },
  { re: /[\u0590-\u05FF]/, code: "he", label: "Hebrew" },
  { re: /[\u0370-\u03FF]/, code: "el", label: "Greek" },
];

/**
 * Distinctive function words — articles/prepositions/frequent markers that
 * survive topic mixing. A hit requires ≥2 distinct words so one borrowed
 * token ("déjà vu", "piñata") cannot flip the locale.
 */
const WORD_MARKS: Array<{ code: string; label: string; words: string[] }> = [
  { code: "fr", label: "French", words: ["les", "des", "une", "dernières", "nouvelles", "aujourd", "avec", "dans", "pour", "est", "france", "français"] },
  { code: "de", label: "German", words: ["der", "die", "das", "und", "aktuelle", "nachrichten", "heute", "deutschland", "mit", "für", "nicht"] },
  { code: "es", label: "Spanish", words: ["las", "los", "unas", "últimas", "noticias", "hoy", "españa", "mexico", "méxico", "para", "con", "que", "qué"] },
  { code: "it", label: "Italian", words: ["ultime", "notizie", "oggi", "italia", "italiane", "per", "con", "che", "sono", "delle"] },
  { code: "pt", label: "Portuguese", words: ["últimas", "notícias", "hoje", "brasil", "portugal", "para", "com", "que", "não"] },
  { code: "hi", label: "Hindi (Latin script)", words: ["kya", "hai", "kaise", "nahi", "mein", "ki", "ka", "ke", "aur", "hindi"] },
];

const DEFAULT: QueryLanguage = { code: "en", label: "English", via: "default" };

/**
 * Detect the query's language. Non-Latin scripts win immediately (unambiguous);
 * Latin-script languages need ≥2 distinct word markers; anything else —
 * including English itself — stays on the default.
 */
export function detectQueryLanguage(query: string): QueryLanguage {
  const q = String(query ?? "");
  if (!q) return DEFAULT;
  for (const s of SCRIPTS) {
    if (s.re.test(q)) return { code: s.code, label: s.label, via: "script" };
  }
  const lower = q.toLowerCase();
  const tokens = new Set(lower.split(/[^\p{L}]+/u).filter(Boolean));
  for (const lang of WORD_MARKS) {
    let hits = 0;
    for (const w of lang.words) {
      // Word-boundary-ish: a marker may carry a trailing inflection
      // ("aujourd'hui" → "aujourd"), so prefix-match tokens.
      for (const t of tokens) {
        if (t === w || (w.length >= 5 && t.startsWith(w))) {
          hits += 1;
          break;
        }
      }
    }
    if (hits >= 2) return { code: lang.code, label: lang.label, via: "words" };
  }
  return DEFAULT;
}

/** Provider-ready locale with region weight where SearXNG honours it. */
export function providerLocaleFor(query: string): string | undefined {
  const d = detectQueryLanguage(query);
  return d.via === "default" ? undefined : d.code;
}
