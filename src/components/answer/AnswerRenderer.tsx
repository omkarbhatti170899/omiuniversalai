import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileText,
  GitBranch,
  Globe,
  ListChecks,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  detectAnswerShape,
  extractCitations,
  extractSteps,
  extractChecklist,
  isInternalKnowledge,
  parseKnowledgeSections,
  CARD_SECTION_ORDER,
  type Citation,
} from "@/lib/answerShape";
import { cn } from "@/lib/utils";
import { SourceCardList } from "@/components/answer/SourceCards";
import { MarkdownMessage } from "@/components/MarkdownMessage";

/**
 * Structured answer rendering (master UX spec §1/§2/§12).
 *
 * The shape is detected from the finished text and each structure Omi already
 * emits renders as a dedicated card: knowledge plans become a Knowledge card
 * with source chips, procedures become a numbered Step card, web answers get
 * interactive citation chips, and everything else falls back to clean
 * markdown. Nothing is invented — a section card only appears when the text
 * contains it.
 */

// --- Step card --------------------------------------------------------------

function StepCard({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2" aria-label="Steps">
      {steps.map((s, i) => (
        <motion.li
          key={i}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.18, delay: Math.min(i * 0.03, 0.2) }}
          className="flex items-start gap-2.5"
        >
          <span
            aria-hidden
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary"
          >
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 text-sm leading-relaxed">{s}</span>
        </motion.li>
      ))}
    </ol>
  );
}

// --- Checklist card ---------------------------------------------------------

function ChecklistCard({
  items,
}: {
  items: Array<{ text: string; done: boolean }>;
}) {
  return (
    <ul className="space-y-1.5" aria-label="Checklist">
      {items.map((c, i) => (
        <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
              c.done
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border",
            )}
          >
            {c.done ? "✓" : ""}
          </span>
          <span className={cn(c.done && "text-muted-foreground line-through")}>
            {c.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

// --- Source chips + panel (§5) ----------------------------------------------

function SourceChips({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState<Citation | null>(null);
  if (citations.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap gap-1.5" aria-label="Sources">
        {citations.map((c) => (
          <button
            key={c.n}
            type="button"
            onClick={() => setOpen(c)}
            aria-haspopup="dialog"
            className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 py-1 pl-2 pr-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            title={c.hint || `Source ${c.n}`}
          >
            <Globe className="size-3 shrink-0 text-primary/70" />
            <span className="truncate">{c.hint || `Source ${c.n}`}</span>
            <Badge variant="secondary" className="px-1 py-0 text-[10px]">
              {c.n}
            </Badge>
          </button>
        ))}
      </div>
      {open && (
        <div
          role="dialog"
          aria-label={`Source ${open.n}`}
          className="fixed inset-x-4 bottom-4 z-50 rounded-xl border border-border/70 bg-popover p-4 shadow-lg sm:left-auto sm:w-96"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Source {open.n}
              </p>
              <p className="mt-0.5 truncate text-sm font-medium">{open.hint || "Web source"}</p>
            </div>
            <button
              type="button"
              aria-label="Close source panel"
              className="cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(null)}
            >
              ✕
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            This marker refers to a web source Omi read for this answer. The full
            citation list lives in the search panel that produced it.
          </p>
        </div>
      )}
    </>
  );
}

// --- Knowledge card (§4) ----------------------------------------------------

const SECTION_META: Record<string, { icon: typeof BookOpen; tone: string }> = {
  steps: { icon: ListChecks, tone: "text-primary" },
  required: { icon: FileText, tone: "text-sky-400" },
  checks: { icon: ShieldCheck, tone: "text-emerald-400" },
  exceptions: { icon: CircleAlert, tone: "text-amber-400" },
  escalate: { icon: CircleAlert, tone: "text-destructive" },
  conflict: { icon: CircleAlert, tone: "text-destructive" },
  evidence: { icon: BookOpen, tone: "text-muted-foreground" },
  source: { icon: BookOpen, tone: "text-muted-foreground" },
  version: { icon: BookOpen, tone: "text-muted-foreground" },
  answer: { icon: BookOpen, tone: "" },
  note: { icon: CircleAlert, tone: "text-amber-400" },
};

function KnowledgeSectionBody({
  sectionKey,
  body,
}: {
  sectionKey: string;
  body: string;
}) {
  // Steps and checklists get their dedicated cards; every other section is
  // short markdown so links/bullets still work.
  if (sectionKey === "steps") {
    const steps = extractSteps(body);
    if (steps.length > 0) return <StepCard steps={steps} />;
  }
  const checklist = extractChecklist(body);
  if (checklist.length >= 2) return <ChecklistCard items={checklist} />;
  if (sectionKey === "source" || sectionKey === "version") {
    return <p className="text-sm font-medium">{body.split("\n")[0]}</p>;
  }
  return <MarkdownMessage content={body} className="text-sm" />;
}

function KnowledgeCard({ text }: { text: string }) {
  const parsed = parseKnowledgeSections(text)!;
  const internal = isInternalKnowledge(text);
  const present = CARD_SECTION_ORDER.filter(
    (s) => parsed.sections[s.key] !== undefined,
  );

  return (
    <div className="omi-answer-card overflow-hidden rounded-xl border border-border/70">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5">
        <BookOpen className="size-4 shrink-0 text-primary" />
        <span className="text-xs font-semibold uppercase tracking-wide">
          {internal ? "Approved knowledge" : "Knowledge answer"}
        </span>
        {parsed.sections.version && (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {parsed.sections.version.split("\n")[0]}
          </Badge>
        )}
      </div>
      <div className="space-y-4 px-4 py-3">
        {/* The key answer leads (§2 hierarchy). */}
        {parsed.sections.answer && (
          <div className="omi-answer-key rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-3">
            <MarkdownMessage
              content={parsed.sections.answer.split("\n")[0]}
              className="text-sm font-medium"
            />
          </div>
        )}
        {present
          .filter((s) => s.key !== "answer")
          .map((s) => {
            const meta = SECTION_META[s.key] ?? SECTION_META.answer;
            const Icon = meta.icon;
            const isConflict = s.key === "conflict";
            return (
              <section key={s.key} aria-label={s.label} className="min-w-0">
                <h4
                  className={cn(
                    "mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide",
                    isConflict ? "text-destructive" : meta.tone || "text-muted-foreground",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  {s.label}
                </h4>
                <div
                  className={cn(
                    isConflict &&
                      "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2",
                  )}
                >
                  <KnowledgeSectionBody
                    sectionKey={s.key}
                    body={parsed.sections[s.key]!}
                  />
                </div>
              </section>
            );
          })}
      </div>
    </div>
  );
}

// --- Warning card -----------------------------------------------------------

function WarningCard({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <MarkdownMessage content={text} className="text-sm" />
      </div>
    </div>
  );
}

// --- Research wrapper -------------------------------------------------------

function ResearchCard({ text }: { text: string }) {
  const citations = useMemo(() => extractCitations(text), [text]);
  // A current-information answer must let the user judge freshness, so a real
  // URL extracted from the answer becomes a clickable, dated source card.
  // A bare "[3]" marker with no URL stays a chip — inventing a link for it
  // would be exactly the fabrication this product forbids.
  const linkable = useMemo(
    () =>
      citations
        .map((c) => ({ ...c, url: urlForMarker(text, c.n) }))
        .filter((c): c is Citation & { url: string } => typeof c.url === "string"),
    [citations, text],
  );
  return (
    <div className="space-y-3">
      <MarkdownMessage content={text} />
      {linkable.length > 0 ? (
        <SourceCardList
          sources={linkable.map((c) => ({
            idx: c.n,
            title: c.hint || `Source ${c.n}`,
            url: c.url,
          }))}
          title="Sources"
        />
      ) : (
        citations.length > 0 && <SourceChips citations={citations} />
      )}
    </div>
  );
}

/**
 * The URL that belongs to citation marker `[n]`.
 *
 * Two shapes are supported, and only these two — the function never guesses:
 *   1. The inline form: a URL appearing after `[n]` and before the next marker.
 *   2. The source-block form Omi emits: a line beginning `[n] …` that carries a
 *      `URL:` on that line or the next one.
 * Anything else returns null, so a marker with no real link stays a chip rather
 * than acquiring an invented destination.
 */
export function urlForMarker(text: string, n: number): string | null {
  const clean = (raw: string): string => raw.replace(/[.,;:]+$/, "");

  // 1) Inline: first URL after this marker, up to the next marker.
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let start = -1;
  let end = text.length;
  while ((m = re.exec(text)) !== null) {
    if (start === -1 && m[0] === `[${n}]`) {
      start = m.index + m[0].length;
      continue;
    }
    if (start !== -1) {
      end = m.index;
      break;
    }
  }
  if (start !== -1) {
    const inline = /https?:\/\/[^\s)\]"'<>]+/i.exec(text.slice(start, end));
    if (inline) return clean(inline[0]);
  }

  // 2) Source block: a line that starts with this marker, or the line after it.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^\\s*\\[${n}\\]\\s`).test(lines[i])) continue;
    const window = `${lines[i]}\n${lines[i + 1] ?? ""}`;
    const url = /https?:\/\/[^\s)\]"'<>]+/i.exec(window);
    if (url) return clean(url[0]);
  }
  return null;
}

// --- Comparison (table) -----------------------------------------------------

function ComparisonCard({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2">
      <MarkdownMessage content={text} />
      {text.length > 1400 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex cursor-pointer items-center gap-1 text-xs font-medium text-primary"
        >
          <GitBranch className="size-3.5" />
          {expanded ? "Show less" : "Show full comparison"}
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

// --- Entry point ------------------------------------------------------------

export function AnswerRenderer({ content }: { content: string }) {
  const shape = useMemo(() => detectAnswerShape(content), [content]);

  switch (shape) {
    case "knowledge":
      return <KnowledgeCard text={content} />;
    case "procedure": {
      const steps = extractSteps(content);
      // Only card-ify when the whole reply IS the procedure; a long mixed
      // answer with a few numbers renders as markdown.
      if (steps.length >= 2 && content.length < 2500) {
        return (
          <div className="space-y-3">
            <MarkdownMessage content={content.replace(/^\s*\d+[.)].*$/gm, "").trim()} />
            <div className="omi-answer-card rounded-xl border border-border/70 px-4 py-3">
              <StepCard steps={steps} />
            </div>
          </div>
        );
      }
      return <MarkdownMessage content={content} />;
    }
    case "checklist": {
      const items = extractChecklist(content);
      if (items.length >= 2) {
        return (
          <div className="space-y-3">
            <MarkdownMessage content={content.replace(/^\s*[-*]\s+\[[ xX]\].*$/gm, "").trim()} />
            <div className="omi-answer-card rounded-xl border border-border/70 px-4 py-3">
              <ChecklistCard items={items} />
            </div>
          </div>
        );
      }
      return <MarkdownMessage content={content} />;
    }
    case "comparison":
      return <ComparisonCard text={content} />;
    case "research":
      return <ResearchCard text={content} />;
    case "warning":
      return <WarningCard text={content} />;
    default:
      return <MarkdownMessage content={content} />;
  }
}

/** Collapsible evidence drawer — the "optional deep details" tier of §2. */
export function AnswerDetails({
  reasoning,
  sources,
}: {
  reasoning?: string;
  sources?: React.ReactNode;
}) {
  if (!reasoning && !sources) return null;
  return (
    <Collapsible className="mt-3 border-t border-border/60 pt-2">
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-xs font-medium text-primary">
        <ExternalLink className="size-3.5" />
        Why this answer
        <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {reasoning && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {reasoning}
          </p>
        )}
        {sources}
      </CollapsibleContent>
    </Collapsible>
  );
}
