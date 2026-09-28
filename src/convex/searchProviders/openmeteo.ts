import axios from "axios";
import {
  ProviderUnavailableError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** Pure helper: does this query want weather/structured data? */
export function isWeatherQuery(q: string): boolean {
  return /\b(weather|temperature|forecast|rain(?:fall)?|snow|humidity|wind|uv index|heat ?wave|weather today)\b/i.test(
    q ?? "",
  );
}

export type WeatherRow = {
  name?: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
};

export type ForecastRow = {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  hourly?: {
    time?: string[];
    precipitation_probability?: number[] | null;
  };
};

const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  80: "rain showers",
  95: "thunderstorm",
};

/** Pure helper: compose the conditions sentence from API rows. */
export function composeWeatherCitation(
  place: WeatherRow,
  fx: ForecastRow,
  now = Date.now(),
): { title: string; url: string; snippet: string; publishedAt: string } | null {
  if (
    typeof place.latitude !== "number" ||
    typeof place.longitude !== "number" ||
    !place.name
  ) {
    return null;
  }
  const cur = fx.current;
  if (!cur || typeof cur.temperature_2m !== "number") return null;

  const label = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  const cond = WMO[cur.weather_code ?? -1] ?? "conditions";
  const parts = [
    `Weather in ${label}: ${Math.round(cur.temperature_2m)}°C, ${cond}`,
  ];
  if (typeof cur.wind_speed_10m === "number") parts.push(`wind ${Math.round(cur.wind_speed_10m)} km/h`);
  if (typeof cur.relative_humidity_2m === "number") parts.push(`humidity ${Math.round(cur.relative_humidity_2m)}%`);
  const nextPrecip = fx.hourly?.precipitation_probability?.[0];
  if (typeof nextPrecip === "number") parts.push(`precipitation chance ${nextPrecip}% (next hour)`);

  const url = `https://open-meteo.com/?latitude=${place.latitude}&longitude=${place.longitude}`;
  return {
    title: `Current weather — ${label}`,
    url,
    snippet: `${parts.join(", ")}. Data: Open-Meteo.com (open data, CC-BY 4.0). Retrieved ${new Date(now).toISOString().slice(0, 16)} UTC.`,
    /**
     * A live observation's publish time IS the moment it was retrieved. The
     * citation previously carried no timestamp, so the freshness gate — which
     * correctly treats an undated result as NOT current — was discarding real,
     * live weather data. This is an observation, not an article, so the
     * retrieval time is the honest timestamp.
     */
    publishedAt: new Date(now).toISOString(),
  };
}

/**
 * Open-Meteo weather provider (master plan §5: weather/structured open
 * data). Fully keyless, no account, $0, CC-BY 4.0 attribution carried in
 * the snippet. Two-step: geocode → current conditions + next-hour
 * precipitation. Scope-gated: only fires on weather-phrased queries so the
 * parallel budget is never wasted on the 11 other sources' strengths.
 */
export function createOpenMeteoProvider(): SearchProvider {
  return {
    id: "openmeteo",
    label: "Open-Meteo (weather, open data)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults): Promise<SearchProviderResult> {
      if (!isWeatherQuery(query)) return { citations: [] };

      try {
        const place = extractPlace(query);
        if (place.length < 3) return { citations: [] };

        const geo = await axios.get(GEOCODE_URL, {
          params: { name: place.slice(0, 80), count: 1, language: "en", format: "json" },
          timeout: 10000,
        });
        const hit = (geo.data?.results ?? [])[0] as WeatherRow | undefined;
        if (!hit) return { citations: [] };

        const fx = await axios.get(FORECAST_URL, {
          params: {
            latitude: hit.latitude,
            longitude: hit.longitude,
            current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
            hourly: "precipitation_probability",
            forecast_hours: 2,
          },
          timeout: 10000,
        });

        const citation = composeWeatherCitation(hit, fx.data as ForecastRow);
        return citation
          ? { citations: numResults > 0 ? [citation] : [] }
          : { citations: [] };
      } catch (err) {
        // NOT a missing key: Open-Meteo is free and keyless. This used to be
        // reported as `Search provider "openmeteo: Request failed with status
        // code 429" is not configured.` — a sentence that sends an operator
        // hunting for a credential that does not exist.
        throw new ProviderUnavailableError(
          `openmeteo: upstream unavailable — ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
    },
  };
}

/**
 * Extract a PLACE NAME from a weather question.
 *
 * MEASURED DEFECT (search-quality benchmark, 2026-09-28): the previous
 * implementation stripped a word list and kept whatever was left, which broke
 * on ordinary phrasing in two ways:
 *
 *   "today's weather"              -> "'s"              (possessive not stripped)
 *   "today's forecast for Sydney"  -> "'s for Sydney"   ("for" never stripped)
 *   "weather in Delhi today"       -> worked
 *
 * The first returned nothing at all, and the second sent "'s for Sydney" to
 * the geocoder, which of course found no such place. So the two questions a
 * user is most likely to type were the two that failed. Possessives, leading
 * prepositions and punctuation are now removed, and the remainder is checked
 * for letters so a purely punctuation/particle string can never be geocoded.
 *
 * Returns "" when the question names no place — the caller must then return no
 * citations, because guessing a location is a wrong forecast, not a missing one.
 */
export function extractPlace(query: string): string {
  let s = ` ${query ?? ""} `;
  // Possessives/contractions FIRST, so "today's" becomes "today " and not "'s".
  s = s.replace(/['\u2019](?:s|re|ll|ve|d)?\b/gi, " ");
  // Weather vocabulary.
  s = s.replace(
    /\b(weather|temperature|temperatures|forecast|forecasts|rain(?:fall)?|raining|snow(?:ing|fall)?|humidity|wind(?:y|s)?|uv index|heat ?wave|cold ?wave|conditions?|climate)\b/gi,
    " ",
  );
  // Time vocabulary — describes WHEN, never WHERE.
  s = s.replace(
    /\b(today|tonight|tomorrow|yesterday|now|currently|current|right now|latest|this (?:morning|afternoon|evening|week|weekend|month))\b/gi,
    " ",
  );
  // Function words, including the prepositions that previously survived.
  s = s.replace(
    /\b(what'?s|whats|what is|what|how|is|are|was|will it|it|the|a|an|do i need|need|like|please|tell me|me|and|in|at|for|of|near|around|on|to|from|about)\b/gi,
    " ",
  );
  // Anything that is not a letter/digit/space/comma/hyphen/apostrophe.
  s = s.replace(/[^\p{L}\p{N}\s,'-]/gu, " ");
  s = s.replace(/[,\-']/g, " ").replace(/\s+/g, " ").trim();
  // A place name contains letters; a string of particles does not.
  if (!/\p{L}/u.test(s)) return "";
  return s.slice(0, 80);
}
