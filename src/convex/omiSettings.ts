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
};

const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** Merge a stored row over the defaults — unknown/legacy values fall back. */
export function withDefaults(row: Partial<OmiSettings> | null | undefined): OmiSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  const pref = row.providerPreference;
  return {
    providerPreference:
      pref && (PROVIDER_PREFERENCES as readonly string[]).includes(pref)
        ? pref
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
