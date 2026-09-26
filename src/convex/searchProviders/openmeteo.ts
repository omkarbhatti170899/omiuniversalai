import axios from "axios";
import {
  MissingKeyError,
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
        // Extract a place name: strip weather words, take what's left.
        const place = query
          .replace(
            /\b(weather|temperature|forecast|rain(?:fall)?|snow|humidity|wind|uv index|heat ?wave|today|tomorrow|now|current|in|at|the|what'?s|is)\b/gi,
            " ",
          )
          .replace(/\s+/g, " ")
          .trim();
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
        throw new MissingKeyError(
          `openmeteo: ${err instanceof Error ? err.message : "unavailable"}`,
        );
      }
    },
  };
}
