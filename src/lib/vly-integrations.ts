// VLY Integrations — raw gateway transport only.
//
// All provider routing, model selection and fallback logic lives in
// src/convex/aiProviders/ (master spec §3/§4). This module is just one
// adapter's transport and must stay free of routing/fallback logic so the
// runtime never becomes dependent on a single vendor.

import { createVlyIntegrations } from '@vly-ai/integrations';

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

export type CompletionRequest = {
  model?: string;
  messages: ChatMsg[];
  temperature?: number;
  maxTokens?: number;
};

export type CompletionData = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { totalTokens?: number };
};

export type CompletionResult = {
  success: boolean;
  data?: CompletionData;
  error?: string;
};

const vly = createVlyIntegrations({
  deploymentToken: process.env.VLY_INTEGRATION_KEY ?? "",
  debug: process.env.NODE_ENV === 'development'
});

const vlyAi = vly.ai as {
  completion: (req: CompletionRequest) => Promise<CompletionResult>;
};

/** Raw VLY gateway call. Returns success:false on any failure (never throws). */
export async function vlyGatewayCompletion(
  req: CompletionRequest,
): Promise<CompletionResult> {
  try {
    return await vlyAi.completion(req);
  } catch (e) {
    return {
      success: false,
      error: `VLY gateway failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
