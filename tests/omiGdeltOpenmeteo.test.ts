/**
 * Milestone tests — GDELT (news) and Open-Meteo (weather) providers:
 * scope gates protect the parallel budget, pure mapping is exact, and both
 * register keyless/$0 in Andromeda.
 */
import { describe, test, expect } from "bun:test";
import { isNewsQuery, mapArticleToCitation } from "../src/convex/searchProviders/gdelt";
import {
  isWeatherQuery,
  composeWeatherCitation,
} from "../src/convex/searchProviders/openmeteo";

describe("gdelt — scope gate", () => {
  test("news-phrased queries pass", () => {
    for (const q of [
      "latest AI regulation news",
      "chip merger announced this week",
      "earnings reported for battery makers",
    ]) {
      expect(isNewsQuery(q)).toBe(true);
    }
  });
  test("non-news queries are refused", () => {
    for (const q of ["how do heat pumps work", "definition of entropy", "postgres vs mysql"]) {
      expect(isNewsQuery(q)).toBe(false);
    }
  });
});

describe("gdelt — mapping", () => {
  test("seendate converts to ISO and domain is preserved", () => {
    const c = mapArticleToCitation({
      url: "https://example.com/a",
      title: "Big battery announcement",
      seendate: "20260919T083000Z",
      domain: "example.com",
    });
    expect(c!.publishedAt).toBe("2026-09-19T08:30:00Z");
    expect(c!.snippet).toContain("example.com");
    expect(c!.title.length).toBeLessThanOrEqual(200);
  });
  test("rows without url/title are dropped", () => {
    expect(mapArticleToCitation({ title: "only title" })).toBeNull();
  });
});

describe("open-meteo — scope gate and composition", () => {
  test("weather queries pass, others don't", () => {
    expect(isWeatherQuery("weather in Helsinki")).toBe(true);
    expect(isWeatherQuery("temperature in Cairo today")).toBe(true);
    expect(isWeatherQuery("best restaurants in Helsinki")).toBe(false);
  });

  test("composes conditions with attribution and provenance", () => {
    const c = composeWeatherCitation(
      { name: "Helsinki", country: "Finland", latitude: 60.17, longitude: 24.94 },
      {
        current: { temperature_2m: 12.4, wind_speed_10m: 21, relative_humidity_2m: 71, weather_code: 61 },
        hourly: { time: ["2026-09-20T13:00"], precipitation_probability: [40] },
      },
    );
    expect(c!.title).toContain("Helsinki");
    expect(c!.snippet).toContain("12°C");
    expect(c!.snippet).toContain("light rain");
    expect(c!.snippet).toContain("40%");
    expect(c!.snippet).toContain("Open-Meteo.com");
    expect(c!.url).toContain("latitude=60.17");
  });

  test("incomplete rows are rejected honestly", () => {
    expect(
      composeWeatherCitation({ name: "X" }, { current: { temperature_2m: 5 } }),
    ).toBeNull();
  });
});

describe("registration — both sources live in Andromeda", () => {
  test("gdelt and openmeteo registered keyless and $0", async () => {
    const { getProviderStatus } = await import("../src/convex/searchProviders");
    const ids = getProviderStatus().map((p) => p.id);
    expect(ids).toContain("gdelt");
    expect(ids).toContain("openmeteo");
    for (const p of getProviderStatus()) expect(p.cost).toMatch(/\$0/);
  });
});
