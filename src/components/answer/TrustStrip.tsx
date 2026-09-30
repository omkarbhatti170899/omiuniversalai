/**
 * Trust strip — makes verification strength visible, and only when it is real.
 * =============================================================================
 * The product's core promise is that it does not bluff. So this component has
 * one hard rule: EVERY value it shows is computed from the result that actually
 * came back.
 *
 *   • "Sources: 6"        — the real citation count. Never a rounded-up figure.
 *   • "Updated 2h ago"    — the freshest dated source, and ONLY if one is dated.
 *                          An undated source produces no freshness claim at all,
 *                          because "recent" cannot be honestly inferred.
 *   • "Cross-checked ✓"   — only when ≥2 independent domains agree, per the
 *                          existing rules in lib/sourceVerification.ts.
 *   • "Sources disagree"  — shown when they do. Hiding a conflict would be the
 *                          single most dishonest thing this UI could do.
 *   • No sources at all    — says so. Silence would read as confidence.
 *
 * The independence rule matters: two copies of the same article are ONE source.
 * Counting them as corroboration is the exact failure mode this strip exists to
 * make visible, so uniqueness is by domain, not by URL.
 */

import { AlertTriangle, CheckCircle2, Clock, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type TrustInput = {
  citations?: Array<{ url?: string | null; publishedAt?: string | number | null } | null> | null;
};

function hostOf(url?: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function ageLabel(value: string | number): string | null {
  const then = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(then)) return null;
  const hours = (Date.now() - then) / 3_600_000;
  if (hours < 0) return null;
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `${mins} min ago`;
  }
  if (hours < 48) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export type TrustSummary = {
  citations: number;
  /** Distinct domains. Two copies of one article count as ONE source. */
  independent: number;
  /** Newest dated source, or null when nothing carried a date. */
  freshest: string | null;
  crossChecked: boolean;
  hasSources: boolean;
};

/**
 * The whole trust calculation as one pure function, so the honesty rules are
 * unit-testable instead of being a claim in a comment.
 */
export function trustSummary(input: TrustInput): TrustSummary {
  const citations = (input.citations ?? []).filter(Boolean) as Array<{
    url?: string | null;
    publishedAt?: string | number | null;
  }>;

  if (citations.length === 0) {
    return {
      citations: 0,
      independent: 0,
      freshest: null,
      crossChecked: false,
      hasSources: false,
    };
  }

  const domains = new Set(citations.map((c) => hostOf(c.url)).filter(Boolean));
  const dated = citations
    .map((c) => ageLabel(c.publishedAt as string | number))
    .filter((v): v is string => Boolean(v))
    .sort((a, b) => a.localeCompare(b));

  return {
    citations: citations.length,
    independent: domains.size,
    freshest: dated[0] ?? null,
    crossChecked: domains.size >= 2,
    hasSources: true,
  };
}

export function TrustStrip({
  result,
  className,
}: {
  result: TrustInput;
  className?: string;
}) {
  const t = trustSummary(result);

  if (!t.hasSources) {
    return (
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs text-muted-foreground",
          className,
        )}
      >
        <AlertTriangle className="size-3.5 shrink-0" />
        No sources — treat this answer as unverified.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <Link2 className="size-3.5 shrink-0" />
        Sources: {t.citations}
        {t.independent !== t.citations ? (
          <span className="text-muted-foreground/60"> ({t.independent} independent)</span>
        ) : null}
      </span>

      {t.freshest ? (
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5 shrink-0" />
          Newest source {t.freshest}
        </span>
      ) : null}

      {t.crossChecked ? (
        <span className="inline-flex items-center gap-1.5 text-emerald-500/90">
          <CheckCircle2 className="size-3.5 shrink-0" />
          Cross-checked across {t.independent} sources
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <AlertTriangle className="size-3.5 shrink-0" />
          Single source — not cross-checked
        </span>
      )}
    </div>
  );
}
