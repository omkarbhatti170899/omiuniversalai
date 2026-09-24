/**
 * Provider redundancy + gateway-disable tests.
 *
 * Pins the two routing decisions behind ISSUE 1 / ISSUE 2:
 *   • a deployment can remove a provider from the chain without deleting it
 *     (the rejected workspace gateway) — OMI_DISABLE_PROVIDERS
 *   • a second, independent provider (Gemini) is wired and ready so one
 *     provider's outage or rate limit never stalls every capability
 *
 * The workspace gateway's key is platform-injected and cannot be deleted from
 * the deployment, so "removed" here means: configured but NEVER routed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  AI_PROVIDERS,
  GEMINI_URL,
  isProviderDisabled,
} from "../src/convex/aiProviders/catalog";
import { decideAfterFailedAttempt } from "../src/convex/aiProviders";

const prevDisable = process.env["OMI_DISABLE_PROVIDERS"];

afterEach(() => {
  if (prevDisable === undefined) delete process.env["OMI_DISABLE_PROVIDERS"];
  else process.env["OMI_DISABLE_PROVIDERS"] = prevDisable;
});


describe("OMI_DISABLE_PROVIDERS — the kill switch", () => {
  test("an unset flag disables nothing", () => {
    delete process.env["OMI_DISABLE_PROVIDERS"];
    expect(isProviderDisabled("vly")).toBe(false);
    expect(isProviderDisabled("groq")).toBe(false);
  });

  test("a listed provider is disabled (case-insensitive, tolerates spaces)", () => {
    process.env["OMI_DISABLE_PROVIDERS"] = " Vly , openai";
    expect(isProviderDisabled("vly")).toBe(true);
    expect(isProviderDisabled("VLY")).toBe(true);
    expect(isProviderDisabled("openai")).toBe(true);
    expect(isProviderDisabled("groq")).toBe(false);
  });

  test("an empty value disables nothing", () => {
    process.env["OMI_DISABLE_PROVIDERS"] = "";
    expect(isProviderDisabled("vly")).toBe(false);
  });
});

describe("the rejected workspace gateway is out of the routing chain", () => {
  test("vly is NOT registered as an active provider at all", () => {
    // Removal beats a disable flag: nothing can route to a provider that is
    // not in the registry, and /status can no longer call it "configured".
    expect(AI_PROVIDERS.some((p) => p.id === "vly")).toBe(false);
  });

  test("the kill switch remains available for OTHER deployments/providers", () => {
    // The mechanism that took the gateway out (isProviderDisabled) stays —
    // it is how any provider can be removed per-deployment without a deploy.
    process.env["OMI_DISABLE_PROVIDERS"] = "gemini";
    expect(isProviderDisabled("gemini")).toBe(true);
    delete process.env["OMI_DISABLE_PROVIDERS"];
    expect(isProviderDisabled("gemini")).toBe(false);
  });
});

describe("Gemini — the independent secondary provider", () => {
  test("is registered with its own key, free-tier cost, and fallback models", () => {
    const gemini = AI_PROVIDERS.find((p) => p.id === "gemini");
    expect(gemini).toBeDefined();
    expect(gemini!.envKeys).toEqual(["GEMINI_API_KEY"]);
    expect(gemini!.fallbackModels.length).toBeGreaterThan(0);
    // Independent quota is the point: it is NOT a second Groq account.
    expect(gemini!.envKeys).not.toContain("GROQ_API_KEY");
  });

  test("the router order puts a working free provider first and Gemini second", () => {
    const ids = AI_PROVIDERS.map((p) => p.id);
    expect(ids.indexOf("groq")).toBeLessThan(ids.indexOf("gemini"));
    // Groq primary → Gemini secondary → metered/optional adapters after.
    expect(ids.indexOf("gemini")).toBeLessThan(ids.indexOf("openai"));
  });

  test("all task models are set (no task can fall through to undefined)", () => {
    const gemini = AI_PROVIDERS.find((p) => p.id === "gemini")!;
    for (const model of Object.values(gemini.taskModels)) {
      expect(typeof model).toBe("string");
      expect(model.length).toBeGreaterThan(0);
    }
  });

  test("endpoint is Google's OpenAI-compatible surface over HTTPS", () => {
    expect(GEMINI_URL.startsWith("https://")).toBe(true);
    expect(GEMINI_URL).toContain("generativelanguage.googleapis.com");
    expect(GEMINI_URL.endsWith("/chat/completions")).toBe(true);
  });

  test("model IDs are namespaced per provider convention (no cross-provider leakage)", () => {
    const gemini = AI_PROVIDERS.find((p) => p.id === "gemini")!;
    const all = [...Object.values(gemini.taskModels), ...gemini.fallbackModels];
    for (const m of all) expect(m.startsWith("gemini")).toBe(true);
  });
});

describe("fallback doctrine still holds with the new chain", () => {
  test("a rate-limited primary moves to the next PROVIDER, not a sibling model", () => {
    // Groq's tier cap (429) applies to every Groq model — the only correct
    // move is the next provider, which is exactly what Gemini is for.
    expect(decideAfterFailedAttempt("error 429: request too large", false)).toBe(
      "next_provider",
    );
  });

  test("a retired model still tries the provider's own fallback models first", () => {
    expect(
      decideAfterFailedAttempt("the model does not exist (404)", false),
    ).toBe("next_candidate");
  });

  test("an empty completion tries the same provider's next model", () => {
    expect(decideAfterFailedAttempt("whatever", true)).toBe("next_candidate");
  });
});

describe("secret hygiene in provider metadata", () => {
  test("no descriptor ever embeds a key value — only env var NAMES", () => {
    const serialized = JSON.stringify(AI_PROVIDERS);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(serialized).not.toMatch(/AIza[A-Za-z0-9_-]{10,}/); // Gemini key shape
    expect(serialized).not.toMatch(/gsk_[A-Za-z0-9]{8,}/); // Groq key shape
  });
});
