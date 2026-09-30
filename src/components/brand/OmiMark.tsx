/**
 * OMI UNIVERSAL AI — brand components.
 * =============================================================================
 * ONE mark, used everywhere. This is the in-app twin of public/logo.svg: same
 * geometry (core r=74, ring rx=176 ry=132 rotated -22deg, three nodes), written
 * as inline SVG rather than an <img> for three reasons:
 *
 *   1. Crispness — it scales to any size without a second raster asset.
 *   2. Theme awareness — the wordmark is real text, so it inherits the
 *      foreground colour and stays selectable/translatable.
 *   3. Motion honesty — the entrance animation below is attached to ONE element
 *      and is disabled under prefers-reduced-motion (index.css), so a returning
 *      user is never held behind an animation they have already seen.
 *
 * Do NOT add a second logo. Variants live in public/ (mono, lockup, maskable,
 * PNGs) and are all generated from or mirrored by this geometry.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useId } from "react";
import { cn } from "@/lib/utils";

export const BRAND = {
  name: "Omi Universal AI",
  descriptor: "Universal Intelligence",
  motto: "One Intelligence. Infinite Possibilities.",
  creator: "Created by Omkar Prakash Bhatti",
} as const;

type MarkProps = {
  className?: string;
  /** Adds the slow breathing bloom. Only for hero placement — never in lists. */
  animated?: boolean;
  title?: string;
};

/**
 * The symbol. Gradient ids are suffixed with `useId` so several marks can
 * coexist on one page without one instance silently reusing another's gradient.
 */
export function OmiMark({ className, animated = false, title }: MarkProps) {
  const reduce = useReducedMotion();
  // useId guarantees uniqueness per component instance; the character class is
  // stripped because React's ids contain colons, which are legal in HTML but
  // break `url(#…)` references in some engines.
  const uid = `omi${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const breathe = animated && !reduce;

  return (
    <svg
      viewBox="0 0 512 512"
      className={cn("shrink-0", className)}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={`${uid}-core`} x1="186" y1="186" x2="326" y2="326" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8B98FF" />
          <stop offset="0.55" stopColor="#6E7BFF" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
        <linearGradient id={`${uid}-ring`} x1="96" y1="120" x2="416" y2="392" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22D3EE" stopOpacity="0.9" />
          <stop offset="0.5" stopColor="#6E7BFF" stopOpacity="0.75" />
          <stop offset="1" stopColor="#8B98FF" stopOpacity="0.55" />
        </linearGradient>
        <radialGradient id={`${uid}-glow`} cx="256" cy="256" r="196" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6E7BFF" stopOpacity="0.3" />
          <stop offset="0.55" stopColor="#6E7BFF" stopOpacity="0.1" />
          <stop offset="1" stopColor="#6E7BFF" stopOpacity="0" />
        </radialGradient>
      </defs>

      <motion.circle
        cx="256"
        cy="256"
        r="196"
        fill={`url(#${uid}-glow)`}
        animate={breathe ? { opacity: [0.75, 1, 0.75] } : undefined}
        transition={breathe ? { duration: 7, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
      <g transform="rotate(-22 256 256)">
        <ellipse
          cx="256"
          cy="256"
          rx="176"
          ry="132"
          fill="none"
          stroke={`url(#${uid}-ring)`}
          strokeWidth="11"
          strokeLinecap="round"
        />
        <circle cx="424" cy="256" r="19" fill={`url(#${uid}-core)`} />
        <circle cx="140" cy="192" r="13" fill="#22D3EE" />
        <circle cx="196" cy="374" r="11" fill="#8B98FF" />
      </g>
      <circle cx="256" cy="256" r="74" fill={`url(#${uid}-core)`} />
    </svg>
  );
}

type WordmarkProps = {
  className?: string;
  /** Renders the descriptor line under the wordmark. */
  withDescriptor?: boolean;
};

/** OMI + UNIVERSAL INTELLIGENCE, as real text. Never an image of text. */
export function OmiWordmark({ className, withDescriptor = true }: WordmarkProps) {
  return (
    <span className={cn("flex flex-col leading-none", className)}>
      <span className="text-[1.6em] font-bold leading-none tracking-[0.22em] text-foreground">
        OMI
      </span>
      {withDescriptor ? (
        <span className="mt-[0.5em] text-[0.42em] font-medium uppercase tracking-[0.3em] text-muted-foreground">
          {BRAND.descriptor}
        </span>
      ) : null}
    </span>
  );
}

type LockupProps = {
  className?: string;
  markClassName?: string;
  withDescriptor?: boolean;
  animated?: boolean;
  title?: string;
};

/** Mark + wordmark, the default signature for headers, menus and empty states. */
export function OmiLockup({
  className,
  markClassName,
  withDescriptor = true,
  animated = false,
  title = BRAND.name,
}: LockupProps) {
  return (
    <span className={cn("flex items-center gap-3", className)}>
      <OmiMark className={cn("size-9", markClassName)} animated={animated} title={title} />
      <OmiWordmark withDescriptor={withDescriptor} />
    </span>
  );
}
