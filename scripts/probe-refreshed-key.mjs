// Disposable probe — checks whether the refreshed key reached the deployment
// and whether the gateway accepts it. Prints only a masked fingerprint.
import { execSync } from "node:child_process";

const key = execSync("bun convex env get VLY_INTEGRATION_KEY", { encoding: "utf8" })
  .trim()
  .split("\n")
  .pop()
  .trim();

console.log("fingerprint:", `len=${key.length} prefix=${key.slice(0, 3)}… last4=${key.slice(-4)}`);

try {
  const res = await fetch("https://integrations.vly.ai/v1/llm/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 10,
    }),
  });
  const body = (await res.text()).slice(0, 200).replaceAll(key, "***");
  console.log("gateway status:", res.status);
  console.log("gateway body:", body);
} catch (e) {
  console.log("gateway request failed:", e.message);
}
