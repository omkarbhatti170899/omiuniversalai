import { ExternalLink, Clock3, Globe, ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { verificationFor, verificationSentence, type VerificationInfo } from "@/lib/sourceVerification";

/**
 * Source cards for current-information answers (§8).
 *
 * The rule this component exists to enforce: a source is only useful if the
 * user can judge HOW FRESH it is. A list of bare links hides that. So every
 * card shows, honestly:
 *
 *   • the source title
 *   • the publisher (domain)
 *   • the PUBLISHED / UPDATED time — or, when the source exposed no date, an
 *     explicit "date not shown" state. Never a guess.
 *   • a clickable link out
 *
 * Undated sources are visually de-emphasised rather than hidden, because
 * hiding them would misrepresent what the answer is based on.
 */

export type SourceCardData = {
  /** 1-based index matching the inline [n] marker in the answer. */
  idx?: number;
  title: string;
  url: string;
  /** Publisher shown next to the title; derived from the URL when absent. */
  domain?: string;
  /** ISO publish or update time, when the source provided one. */
  publishedAt?: string | null;
  snippet?: string;
};

/** Host of a URL, without the `www.` prefix. Never throws. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown source";
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Human relative age: "just now", "3 hours ago", "yesterday", "2 months ago".
 * Returns null when the timestamp is missing or unparseable — the caller then
 * renders the honest "date not shown" state instead of inventing one.
 */
export function sourceAgeLabel(
  publishedAt: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!publishedAt) return null;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return null;
  // A small forward offset is normal timezone/clock skew; a large one is not
  // freshness, it is an unusable timestamp. Reporting a far-future date as
  // "just now" would be exactly the kind of quiet invention this product
  // forbids, so it degrades to the honest "date not shown" state instead.
  if (t - now > 6 * HOUR) return null;
  const ms = Math.max(0, now - t);
  if (ms < 2 * MINUTE) return "just now";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min ago`;
  if (ms < 2 * HOUR) return "an hour ago";
  if (ms < DAY) return `${Math.round(ms / HOUR)} hours ago`;
  if (ms < 2 * DAY) return "yesterday";
  if (ms < 30 * DAY) return `${Math.round(ms / DAY)} days ago`;
  if (ms < 365 * DAY) return `${Math.round(ms / (30 * DAY))} months ago`;
  return "over a year ago";
}

/** Absolute timestamp for the tooltip, so the relative label is verifiable. */
function absoluteLabel(publishedAt: string): string {
  const d = new Date(publishedAt);
  return Number.isFinite(d.getTime()) ? d.toUTCString() : publishedAt;
}

export function SourceCard({
  source,
  className,
  now,
}: {
  source: SourceCardData;
  className?: string;
  now?: number;
}) {
  const domain = source.domain ?? hostOf(source.url);
  const age = sourceAgeLabel(source.publishedAt, now);
  const dated = age !== null;

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "group flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        // An undated source is visibly weaker: it cannot support a "current"
        // claim, and the user deserves to see that at a glance.
        dated
          ? "border-border/60 bg-card/50 hover:border-primary/40 hover:bg-card/80"
          : "border-dashed border-border/50 bg-muted/20 hover:border-border/70",
        className,
      )}
    >
      {source.idx !== undefined && (
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold",
            dated ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          {source.idx}
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1.5">
          <span className="line-clamp-2 flex-1 text-xs font-medium leading-snug text-foreground">
            {source.title}
          </span>
          <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary" />
        </span>

        {/* The RELEVANT snippet, so the user can judge whether the source
            actually supports the claim without opening every link. */}
        {source.snippet ? (
          <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground/90">
            {source.snippet}
          </span>
        ) : null}

        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Globe className="size-3" />
            {domain}
          </span>
          <span aria-hidden>·</span>
          {dated ? (
            <span
              className="inline-flex items-center gap-1 text-primary/90"
              title={source.publishedAt ? absoluteLabel(source.publishedAt) : undefined}
            >
              <Clock3 className="size-3" />
              {age}
            </span>
          ) : (
            <span
              className="italic"
              title="This source did not publish a timestamp, so it cannot be treated as current."
            >
              date not shown by the source
            </span>
          )}
        </span>
      </span>
    </a>
  );
}

/**
 * The verification badge.
 *
 * Green ONLY for genuine cross-checking. A single source gets a neutral
 * "Single source" badge, because a green tick next to one link is the single
 * most misleading thing this UI could show.
 */
export function VerificationBadge({ info, className }: { info: VerificationInfo; className?: string }) {
  const Icon = info.verified ? ShieldCheck : info.state === "none" ? ShieldQuestion : ShieldAlert;
  return (
    <span
      data-testid="source-verification"
      data-state={info.state}
      title={info.detail}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        info.verified
          ? "border-primary/40 bg-primary/10 text-primary"
          : info.state === "conflicting"
            ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
            : "border-border/60 bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-2.5" aria-hidden />
      {info.label}
    </span>
  );
}

/** A titled stack of source cards, with a count and an honesty note. */
export function SourceCardList({
  sources,
  title = "Sources",
  emptyNote,
  className,
  now,
}: {
  sources: SourceCardData[];
  title?: string;
  emptyNote?: string;
  className?: string;
  now?: number;
}) {
  if (sources.length === 0) {
    return emptyNote ? (
      <p className={cn("text-xs text-muted-foreground", className)}>{emptyNote}</p>
    ) : null;
  }
  const undated = sources.filter((s) => sourceAgeLabel(s.publishedAt, now) === null).length;
  // Verification is counted by INDEPENDENT DOMAIN, never by link count: one
  // outlet publishing three articles is one source, not three. A single
  // source is labelled "Single source", never "verified".
  const info: VerificationInfo = verificationFor({
    sources: sources.map((s) => ({ domain: s.domain ?? hostOf(s.url) })),
    datedSources: sources.length - undated,
  });
  return (
    <div className={cn("space-y-2", className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {title}
          <span className="font-normal text-muted-foreground/70">
            ({sources.length}
            {undated > 0 ? ` · ${undated} without a date` : ""})
          </span>
        </span>
        <VerificationBadge info={info} />
      </p>
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        {verificationSentence(info)}
      </p>
      <div className="space-y-1.5">
        {sources.map((s, i) => (
          <SourceCard key={`${s.url}-${i}`} source={{ ...s, idx: s.idx ?? i + 1 }} now={now} />
        ))}
      </div>
    </div>
  );
}
