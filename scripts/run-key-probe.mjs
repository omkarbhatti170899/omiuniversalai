// Disposable runner for the temporary keyProbe internal action.
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";

const url = process.env.CONVEX_URL || "https://resolute-ptarmigan-187.convex.cloud";

const client = new ConvexHttpClient(url);
try {
  const result = await client.action(api.keyProbe.probe, {});
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.log("PROBE FAILED:", String(e?.message ?? e).slice(0, 400));
}
