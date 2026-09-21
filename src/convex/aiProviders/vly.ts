/**
 * VLY workspace gateway adapter (master spec §3). The gateway is the
 * workspace-provided AI path; this adapter keeps its transport isolated so
 * the rest of the runtime never touches vendor-specific code directly.
 *
 * The gateway call is bounded by the same deadline as every other provider
 * (§40): a hung gateway fails its attempt inside the router, which then
 * falls through to the next configured provider.
 */

import {
  vlyGatewayCompletion,
  type CompletionRequest,
  type CompletionResult,
} from "../../lib/vly-integrations";
import { withTimeout } from "../searchEngine/resilience";

export async function vlyCompletion(
  req: CompletionRequest,
): Promise<CompletionResult> {
  const timeoutMs = Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 45_000);
  try {
    return await withTimeout(vlyGatewayCompletion(req), timeoutMs, "VLY gateway");
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: /timed out/i.test(raw)
        ? raw
        : `VLY gateway failed: ${raw}`,
    };
  }
}
