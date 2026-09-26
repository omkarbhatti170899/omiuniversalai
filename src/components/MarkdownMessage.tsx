import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** A fenced code block: monospace, horizontal scroll, one-tap copy. */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is still selectable */
    }
  };
  return (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border border-border/70 bg-black/40">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {lang ?? "code"}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Copy code"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className="font-mono">{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  // Our code renderer already supplies its own wrapper — drop the default
  // <pre> so block code is not double-boxed.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children).replace(/\n$/, "");
    const match = /language-(\w+)/.exec(className ?? "");
    const isBlock = Boolean(match) || text.includes("\n");
    if (!isBlock) {
      return (
        <code className="rounded bg-muted/70 px-1 py-0.5 font-mono text-[0.85em]">
          {children}
        </code>
      );
    }
    return <CodeBlock text={text} lang={match?.[1]} />;
  },
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h5>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-primary/50 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border/60 bg-muted/40 px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border/60 px-2 py-1 align-top">{children}</td>
  ),
  hr: () => <hr className="my-3 border-border/60" />,
};

/** Renders an Omi reply as markdown (GFM) with copy-able code blocks. */
export function MarkdownMessage({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 break-words text-sm leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
