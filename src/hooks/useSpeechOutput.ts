import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Omi speech output — TTS via the browser's built-in Web Speech API
 * (master plan §26 AudioProvider: "device/browser capabilities" preferred;
 * paid speech APIs remain optional adapters).
 *
 * Zero cost, no keys, fully on-device. Browsers without `speechSynthesis`
 * report `supported: false` so the UI hides the Speak control instead of
 * faking a feature (§35).
 */

type SpeechSynthesisWindow = Window & {
  speechSynthesis?: SpeechSynthesis;
};

function getSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return (window as SpeechSynthesisWindow).speechSynthesis ?? null;
}

export function useSpeechOutput(opts?: { lang?: string }) {
  const supported = useMemo(() => getSynth() !== null, []);
  const [speaking, setSpeaking] = useState(false);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const lang = opts?.lang ?? "en-US";

  // Keep the cancel-alive ref stable so unmount/interrupt always stops speech.
  useEffect(() => {
    const synth = getSynth();
    return () => {
      try {
        synth?.cancel();
      } catch {
        // page teardown
      }
    };
  }, []);

  const stop = useCallback(() => {
    try {
      getSynth()?.cancel();
    } catch {
      // ignore
    }
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      const synth = getSynth();
      if (!synth) {
        setSpeaking(false);
        return false;
      }
      try {
        synth.cancel(); // one utterance at a time — speak replaces, not queues
        const clipped = text.trim().slice(0, 6000);
        if (clipped.length === 0) return false;

        const utter = new SpeechSynthesisUtterance(clipped);
        utter.lang = lang;
        utter.rate = 1;
        utter.pitch = 1;

        if (voicesRef.current.length === 0) {
          voicesRef.current = synth.getVoices();
        }
        const voices = voicesRef.current;
        const preferred =
          voices.find((v) => v.lang.replace("_", "-") === lang) ??
          voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
        if (preferred) utter.voice = preferred;

        utter.onstart = () => setSpeaking(true);
        utter.onend = () => setSpeaking(false);
        utter.onerror = () => setSpeaking(false);

        synth.speak(utter);
        setSpeaking(true);
        return true;
      } catch {
        setSpeaking(false);
        return false;
      }
    },
    [lang],
  );

  return { supported, speaking, speak, stop };
}
