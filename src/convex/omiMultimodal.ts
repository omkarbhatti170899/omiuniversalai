"use node";

/**
 * Omi Multimodal (master plan Phase 5) — runtime helpers for non-text input.
 *
 * Voice input uses the browser's built-in Web Speech API (Safari/Chrome).
 * That is genuinely free, requires no API key, and keeps audio ON-DEVICE —
 * nothing is uploaded. A local Whisper transcription path can replace this
 * adapter later without touching call sites (SpeechProvider abstraction,
 * master plan Phase 2).
 */

/** Guard against prompt-injection via voice transcripts (untrusted input). */
import { sanitizeUntrustedText } from "./searchEngine/security";

/** True when the current browser exposes speech recognition. */
export function speechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
  );
}

export type VoiceResult = {
  ok: boolean;
  transcript: string;
  error?: string;
};

/**
 * Normalize a raw voice transcript: strip injection patterns, cap length,
 * keep only safe characters. Voice transcripts are untrusted input — the
 * same rules as web page text (Phase 12) apply.
 */
export function normalizeTranscript(raw: string): string {
  return sanitizeUntrustedText(raw, 4000);
}
