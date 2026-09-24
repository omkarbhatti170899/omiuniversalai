import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Omi voice input (master plan Phase 5 — Multimodal / SpeechProvider).
 *
 * Uses the browser's built-in Web Speech API where available (Safari,
 * Chrome). Audio is processed ON-DEVICE by the browser — nothing is
 * uploaded, no API key, zero cost. Browsers without support get `supported:
 * false` and the UI hides the mic instead of faking a feature (master plan
 * §35: no fake features).
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoiceInput(opts?: { lang?: string }) {
  const supported = useMemo(() => getRecognitionCtor() !== null, []);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTextRef = useRef("");

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // already stopped
    }
    setListening(false);
  }, []);

  const language = opts?.lang ?? "en-US";
  const start = useCallback(
    (onFinal: (text: string) => void) => {
      const Ctor = getRecognitionCtor();
      if (!Ctor) {
        setError("Voice input is not supported in this browser.");
        return;
      }
      setError(null);
      finalTextRef.current = "";

      try {
        const rec = new Ctor();
        rec.lang = language;
        rec.continuous = false;
        rec.interimResults = true;

        rec.onresult = (e) => {
          let final = "";
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            const t = r[0]?.transcript ?? "";
            if (r.isFinal) final += t;
            else interim += t;
          }
          if (final) finalTextRef.current += final;
          // Live interim feedback goes through the same callback; callers
          // render it as draft text until the final result arrives.
          onFinal((finalTextRef.current + interim).trimStart());
        };
        rec.onerror = (e) => {
          if (e.error === "no-speech") {
            setError("Didn't catch that — try again.");
          } else if (e.error === "not-allowed" || e.error === "service-not-allowed") {
            setError("Microphone permission denied.");
          } else {
            setError("Voice input failed. Try again.");
          }
          setListening(false);
        };
        rec.onend = () => setListening(false);

        recognitionRef.current = rec;
        rec.start();
        setListening(true);
      } catch {
        setError("Couldn't start voice input.");
        setListening(false);
      }
    },
    [language],
  );

  useEffect(
    () => () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // unmount cleanup
      }
    },
    [],
  );

  return { supported, listening, error, start, stop };
}
