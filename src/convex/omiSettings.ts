/**
 * Omi preferences — per-user, server-side (master plan §12 Settings).
 *
 * Why these live in Convex rather than localStorage: three of them change
 * SERVER behaviour (which provider answers, whether approved memories are
 * injected, whether Andromeda is forced on for chat). A browser-local copy
 * could not influence the pipeline, and a UI control that cannot affect
 * behaviour is a fake control (§35). The rest (voice, image defaults, reduced
 * motion) are read by the client from this same record, so there is exactly
 * one source of truth per user and it follows them across devices.
 *
 * No secret is ever stored or returned here — only enum-ish preferences and
 * booleans. Which providers are *configured* comes from the environment and is
 * reported separately (aiStatus.ts).
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ASPECT_RATIOS } from "./aiProviders/imageCatalog";
import {
  DEFAULT_KNOWLEDGE_MODE,
  parseKnowledgeMode,
  type KnowledgeMode,
} from "./knowledgeEngine/mode";

export const PROVIDER_PREFERENCES = [
  "auto",
  "groq",
  "gemini",
  "openai",
  "deepseek",
] as const;
export type ProviderPreference = (typeof PROVIDER_PREFERENCES)[number];

export type OmiSettings = {
  providerPreference: ProviderPreference;
  /** When false, Omi neither reads nor writes approved memories (§9/§12). */
  memoryEnabled: boolean;
  /** When true, chat turns always go through Andromeda first (current info). */
  alwaysSearch: boolean;
  /** Speak Omi's replies automatically (device speech synthesis, free). */
  autoSpeak: boolean;
  voiceLang: string;
  imageAspectRatio: string;
  reduceMotion: boolean;
  /**
   * Human Emotions AI — when true, every eligible chat turn gets an emotional
   * read and Omi adapts its TONE to it. The read is an inference from wording
   * and is never treated as knowledge of the user's inner state.
   */
  emotionAware: boolean;
  /**
   * Explicit opt-in, OFF by default: also persist automatic read-outs to the
   * Emotions history. Off means emotion-awareness leaves no trace beyond the
   * conversation itself, because inferred emotional data is sensitive.
   */
  emotionHistory: boolean;
  /**
   * Knowledge Intelligence routing (§10/§11): off | prefer | only | research.
   * "only" makes approved internal knowledge the ONLY source (no web search);
   * "research" pairs internal knowledge with Andromeda, always labelled.
   */
  knowledgeMode: KnowledgeMode;
};

/** Defaults are the documented product behaviour — never a null state. */
export const DEFAULT_SETTINGS: OmiSettings = {
  providerPreference: "auto",
  memoryEnabled: true,
  alwaysSearch: false,
  autoSpeak: false,
  voiceLang: "en-US",
  imageAspectRatio: "1:1",
  reduceMotion: false,
  // On by default: tone adaptation is part of Omi's behaviour, and the toggle
  // exists so a user can switch it off entirely (it is never forced).
  emotionAware: true,
  emotionHistory: false,
  knowledgeMode: DEFAULT_KNOWLEDGE_MODE,
};

const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * The RAW stored shape, before validation. A database row is `string | boolean`
 * wide — `providerPreference` in particular is `string` in the schema and only
 * becomes the narrow `ProviderPreference` union once it survives the checks
 * below. Typing this parameter as `Partial<OmiSettings>` (the validated shape)
 * was wrong and only compiled while nothing re-checked the file.
 */
export type OmiSettingsRow = {
  providerPreference?: string;
  memoryEnabled?: boolean;
  alwaysSearch?: boolean;
  autoSpeak?: boolean;
  voiceLang?: string;
  imageAspectRatio?: string;
  reduceMotion?: boolean;
  emotionAware?: boolean;
  emotionHistory?: boolean;
  knowledgeMode?: string;
};

/** Merge a stored row over the defaults — unknown/legacy values fall back. */
export function withDefaults(row: OmiSettingsRow | null | undefined): OmiSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  const pref = row.providerPreference;
  return {
    providerPreference:
      pref && (PROVIDER_PREFERENCES as readonly string[]).includes(pref)
        ? (pref as ProviderPreference)
        : DEFAULT_SETTINGS.providerPreference,
    memoryEnabled: row.memoryEnabled ?? DEFAULT_SETTINGS.memoryEnabled,
    alwaysSearch: row.alwaysSearch ?? DEFAULT_SETTINGS.alwaysSearch,
    autoSpeak: row.autoSpeak ?? DEFAULT_SETTINGS.autoSpeak,
    voiceLang:
      row.voiceLang && LANG_RE.test(row.voiceLang)
        ? row.voiceLang
        : DEFAULT_SETTINGS.voiceLang,
    imageAspectRatio:
      row.imageAspectRatio && row.imageAspectRatio in ASPECT_RATIOS
        ? row.imageAspectRatio
        : DEFAULT_SETTINGS.imageAspectRatio,
    reduceMotion: row.reduceMotion ?? DEFAULT_SETTINGS.reduceMotion,
    emotionAware: row.emotionAware ?? DEFAULT_SETTINGS.emotionAware,
    emotionHistory: row.emotionHistory ?? DEFAULT_SETTINGS.emotionHistory,
    knowledgeMode: parseKnowledgeMode(row.knowledgeMode),
  };
}

/** The signed-in user's preferences (defaults when signed out). */
export const get = query({
  args: {},
  handler: async (ctx): Promise<OmiSettings & { signedIn: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ...DEFAULT_SETTINGS, signedIn: false };
    const row = await ctx.db
      .query("omiSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return { ...withDefaults(row), signedIn: true };
  },
});

/** Same read for actions (chat/routers can't query the DB directly). */
export const getInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<OmiSettings> => {
    const row = await ctx.db
      .query("omiSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return withDefaults(row);
  },
});

/**
 * Partial update — only the fields provided change. Every value is validated
 * before it is stored, so an unknown provider or a malformed language tag can
 * never reach the pipeline.
 */
export const update = mutation({
  args: {
    providerPreference: v.optional(v.string()),
    memoryEnabled: v.optional(v.boolean()),
    alwaysSearch: v.optional(v.boolean()),
    autoSpeak: v.optional(v.boolean()),
    voiceLang: v.optional(v.string()),
    imageAspectRatio: v.optional(v.string()),
    reduceMotion: v.optional(v.boolean()),
    emotionAware: v.optional(v.boolean()),
    emotionHistory: v.optional(v.boolean()),
    knowledgeMode: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<OmiSettings> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to save preferences.");

    const patch: Partial<OmiSettings> = {};
    if (args.providerPreference !== undefined) {
      if (!(PROVIDER_PREFERENCES as readonly string[]).includes(args.providerPreference)) {
        throw new Error("Unknown AI provider preference.");
      }
      patch.providerPreference = args.providerPreference as ProviderPreference;
    }
    if (args.memoryEnabled !== undefined) patch.memoryEnabled = args.memoryEnabled;
    if (args.alwaysSearch !== undefined) patch.alwaysSearch = args.alwaysSearch;
    if (args.autoSpeak !== undefined) patch.autoSpeak = args.autoSpeak;
    if (args.voiceLang !== undefined) {
      if (!LANG_RE.test(args.voiceLang)) throw new Error("Unsupported voice language.");
      patch.voiceLang = args.voiceLang;
    }
    if (args.imageAspectRatio !== undefined) {
      if (!(args.imageAspectRatio in ASPECT_RATIOS)) {
        throw new Error("Unsupported aspect ratio.");
      }
      patch.imageAspectRatio = args.imageAspectRatio;
    }
    if (args.reduceMotion !== undefined) patch.reduceMotion = args.reduceMotion;
    if (args.emotionAware !== undefined) patch.emotionAware = args.emotionAware;
    if (args.emotionHistory !== undefined) patch.emotionHistory = args.emotionHistory;
    if (args.knowledgeMode !== undefined) {
      // Validate (not just parse): an unknown value is a client bug, not a
      // silent downgrade to the default.
      if (parseKnowledgeMode(args.knowledgeMode) !== args.knowledgeMode) {
        throw new Error("Unknown knowledge mode.");
      }
      patch.knowledgeMode = args.knowledgeMode as KnowledgeMode;
    }

    const existing = await ctx.db
      .query("omiSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return withDefaults({ ...existing, ...patch });
    }
    await ctx.db.insert("omiSettings", { userId, ...patch });
    return withDefaults(patch);
  },
});
