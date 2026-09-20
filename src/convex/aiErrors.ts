/**
 * Maps raw AI-gateway failures to actionable, user-facing messages.
 * The gateway is shared by every AI feature, so one mapper keeps
 * all error toasts consistent and free of raw server jargon.
 */
export function friendlyAiError(rawError?: string): string {
  const msg = (rawError ?? "").toLowerCase();

  if (msg.includes("unauthorized") || msg.includes("401")) {
    return (
      "Omi's AI connection needs attention: the workspace AI key is being " +
      "rejected by the AI gateway. Re-copy the project's integration key in the " +
      "Keys/API Keys tab (or re-open the project to refresh it), then try again. " +
      "Everything else keeps working meanwhile."
    );
  }
  if (msg.includes("forbidden") || msg.includes("403")) {
    return (
      "Omi's AI gateway refused this request (403). Check that your workspace's " +
      "integration key is valid in the Keys/API Keys tab, then retry."
    );
  }
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
    return (
      "Omi's AI is rate-limited right now (429). Wait a few seconds and try again."
    );
  }
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econn") ||
    msg.includes("network")
  ) {
    return (
      "Omi couldn't reach its AI provider in time. This is usually temporary — " +
      "try again in a moment."
    );
  }

  return (
    (rawError && rawError.trim().length > 0
      ? `Omi hit a snag: ${rawError}`
      : "Omi hit an unexpected snag. Try again in a moment.")
  );
}
