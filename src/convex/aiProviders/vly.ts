/**
 * VLY workspace gateway adapter (master spec §3). The gateway is the
 * workspace-provided AI path; this adapter keeps its transport isolated so
 * the rest of the runtime never touches vendor-specific code directly.
 */

import {
  vlyGatewayCompletion,
  type CompletionRequest,
  type CompletionResult,
} from "../../lib/vly-integrations";

export function vlyCompletion(
  req: CompletionRequest,
): Promise<CompletionResult> {
  return vlyGatewayCompletion(req);
}
