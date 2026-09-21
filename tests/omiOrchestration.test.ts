/**
 * Phase 14 — Universal orchestration: the intent→capability routing that
 * omiChat now performs before any network call (master plan §5/§14).
 * The router in chat is thin glue; these tests pin the DECISION contract it
 * depends on, plus the calculator integration the calculation branch uses.
 */
import { describe, test, expect } from "bun:test";
import { decideSearch, extractUrl, isCalculation } from "../src/convex/searchEngine/decision";
import { evaluateExpression } from "../src/convex/searchEngine/calculator";

/** Mirrors omiChat's capability selection — the single source of routing. */
function capabilityFor(message: string): "calculator" | "conversational" | "url" | "web" {
  const d = decideSearch(message);
  if (d.intent === "calculation") return "calculator";
  if (d.intent === "conversational" && message.trim().length < 80) return "conversational";
  if (d.intent === "url") return "url";
  return "web";
}

describe("orchestration — capability selection", () => {
  test("greetings never touch the web", () => {
    for (const msg of ["hi", "Hello!", "hey there", "thanks", "good morning"]) {
      expect(capabilityFor(msg)).toBe("conversational");
    }
  });

  test("arithmetic goes to the local sandboxed calculator", () => {
    expect(capabilityFor("what is (12*4)+7")).toBe("calculator");
    expect(capabilityFor("sqrt(144)+2^10")).toBe("calculator");
    expect(capabilityFor("17!")).toBe("calculator");
  });

  test("URLs trigger page analysis, not engine spam", () => {
    expect(capabilityFor("https://example.com/article")).toBe("url");
    expect(capabilityFor("summarize https://en.wikipedia.org/wiki/Star")).toBe("url");
  });

  test("current/news/research/knowledge requests DO search the web", () => {
    expect(capabilityFor("latest news on fusion energy")).toBe("web");
    expect(capabilityFor("what is the current price of gold")).toBe("web");
    expect(capabilityFor("rust vs go for web servers")).toBe("web");
    expect(capabilityFor("how do transformer models work")).toBe("web");
  });

  test("calculation takes priority over knowledge when both match", () => {
    // "what is" filler + arithmetic → must compute, not search.
    expect(decideSearch("what is 23*7").intent).toBe("calculation");
  });

  test("long conversational messages with research phrasing still search", () => {
    // A long "hey, so compare X and Y" message must not be dismissed as chat.
    const long = "hey so I have been wondering, compare solid state batteries vs lithium ion for aviation";
    expect(capabilityFor(long)).toBe("web");
  });
});

describe("orchestration — calculator integration", () => {
  test("chat's calculation branch produces real answers", () => {
    const calc = evaluateExpression("(12*4)+7");
    expect(calc.ok).toBe(true);
    if (calc.ok) expect(calc.formatted).toBe("55");
  });

  test("malformed expressions fail honestly, never throw", () => {
    const calc = evaluateExpression("definitely not math");
    expect(calc.ok).toBe(false);
  });
});

describe("decision engine — supporting helpers", () => {
  test("extractUrl grabs the first URL", () => {
    expect(extractUrl("see https://a.example/x and https://b.example/y")).toBe(
      "https://a.example/x",
    );
  });

  test("isCalculation rejects non-arithmetic", () => {
    expect(isCalculation("what is love")).toBe(false);
    expect(isCalculation("2+2")).toBe(true);
  });
});
