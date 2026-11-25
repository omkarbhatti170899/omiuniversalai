/**
 * OMI UNIVERSAL AI — landing.
 * =============================================================================
 * POSITIONING, corrected. This page used to lead with Emotion AI and describe a
 * customer-support product. That is one of eleven capabilities, and describing
 * the company that way made Omi look smaller than it is. The page now states
 * what Omi is in the first screen and proves it in the second.
 *
 * THE THREE ACCEPTANCE TESTS this page is written against:
 *   5s  — "This is Omi Universal AI."            → mark, name, descriptor, motto
 *   30s — what it does, and where Chat / Andromeda / Research live
 *                                              → capability grid, named routes
 *   60s — I can start asking a question         → one primary CTA, above fold
 *
 * Emotions AI is kept — as one card among eleven, honestly described. Nothing
 * is invented: every capability listed here is a real view in WorkspaceShell.
 */

import { motion } from "framer-motion";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Brain,
  Eye,
  FileText,
  Globe,
  Image as ImageIcon,
  MessageSquare,
  MessagesSquare,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { OmiAmbientField } from "@/components/brand/OmiAmbientField";
import { BRAND, OmiMark } from "@/components/brand/OmiMark";

const fadeUp = {
  initial: { opacity: 0, y: 22 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.55, ease: [0.21, 0.6, 0.35, 1] as const },
};

/**
 * The real capability set. `primary` marks the three a visitor must be able to
 * find in the 30-second test; the rest complete the picture without competing.
 */
const capabilities = [
  {
    icon: MessageSquare,
    title: "Chat",
    body: "Talk to one assistant that reasons, remembers and shows its sources.",
    primary: true,
  },
  {
    icon: Search,
    title: "Andromeda",
    body: "Universal search and research: finds, compares, cross-checks and cites.",
    primary: true,
  },
  {
    icon: Globe,
    title: "Research",
    body: "Longer research runs that gather many sources into one brief.",
    primary: true,
  },
  {
    icon: BookOpen,
    title: "Knowledge",
    body: "Your documents, indexed and answerable with citations.",
  },
  {
    icon: Brain,
    title: "Memory",
    body: "Context that persists between sessions, on your terms.",
  },
  {
    icon: FileText,
    title: "Files",
    body: "PDF, DOCX, XLSX, CSV, TXT and OCR — dropped in, asked about.",
  },
  {
    icon: Eye,
    title: "Vision",
    body: "Show it an image and ask what's in it.",
  },
  {
    icon: Bot,
    title: "Agents",
    body: "Multi-step tasks with tool use and a visible audit trail.",
  },
  {
    icon: Workflow,
    title: "Automation",
    body: "Recurring work that runs without you watching it.",
  },
  {
    icon: ImageIcon,
    title: "Image Studio",
    body: "Generate and edit images when you need them.",
  },
  {
    icon: Sparkles,
    title: "Emotions AI",
    body: "Reads tone and urgency in the messages you receive.",
  },
];

const principles = [
  {
    icon: ShieldCheck,
    title: "It shows its work",
    body: "Claims arrive with sources. If Omi can't verify something, it says so instead of guessing.",
  },
  {
    icon: Search,
    title: "Current means current",
    body: "Fresh, dated sources for anything time-sensitive — and stale material is rejected rather than repeated.",
  },
  {
    icon: Brain,
    title: "Providers are replaceable",
    body: "Retrieval infrastructure sits behind Andromeda. If one source is down, the answer still arrives.",
  },
];

export default function Landing() {
  const { isAuthenticated } = useAuth();

  const primaryHref = isAuthenticated ? "/dashboard" : "/auth";
  const primaryLabel = isAuthenticated ? "Open your workspace" : "Start free";

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      {/* Navbar */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <OmiMark className="size-8" title={BRAND.name} />
            <span className="flex flex-col leading-none">
              <span className="text-[0.95rem] font-bold tracking-[0.2em]">OMI</span>
              <span className="mt-0.5 text-[0.55rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                {BRAND.descriptor}
              </span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#capabilities" className="transition-colors hover:text-foreground">
              Capabilities
            </a>
            <a href="#principles" className="transition-colors hover:text-foreground">
              How it answers
            </a>
            <a href="#start" className="transition-colors hover:text-foreground">
              Get started
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild className="cursor-pointer">
              <Link to={primaryHref}>{primaryLabel}</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero — the 5-second test lives here. */}
      <section className="relative isolate overflow-hidden">
        <OmiAmbientField />
        <div className="relative mx-auto flex w-full max-w-4xl flex-col items-center px-4 pb-20 pt-20 text-center sm:px-6 sm:pt-28">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6 }}
          >
            <OmiMark className="size-20 drop-shadow-[0_10px_50px_rgba(110,123,255,0.32)] sm:size-24" animated title={BRAND.name} />
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08 }}
            className="mt-8 text-4xl font-bold tracking-tight sm:text-6xl"
          >
            OMI <span className="text-primary">Universal AI</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.14 }}
            className="mt-3 text-xs font-medium uppercase tracking-[0.34em] text-muted-foreground"
          >
            {BRAND.descriptor}
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.2 }}
            className="mt-7 text-lg font-medium text-foreground/90 sm:text-xl"
          >
            {BRAND.motto}
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.26 }}
            className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground"
          >
            Omi brings conversation, live research, search, knowledge, memory,
            files, vision and intelligent tools into one workspace.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.34 }}
            className="mt-9 flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
          >
            <Button asChild size="lg" className="h-12 cursor-pointer rounded-xl px-7">
              <Link to={primaryHref}>
                {primaryLabel}
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 cursor-pointer rounded-xl px-7">
              <Link to={isAuthenticated ? "/dashboard" : "/auth"}>Sign in with an email code</Link>
            </Button>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.42 }}
            className="mt-4 text-xs text-muted-foreground"
          >
            No passwords. One-time email codes, or continue as guest.
          </motion.p>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="mt-8 text-[0.7rem] tracking-wide text-muted-foreground/55"
          >
            {BRAND.creator}
          </motion.p>
        </div>
      </section>

      {/* Capabilities — the 30-second test. */}
      <section id="capabilities" className="border-t border-border/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
            <Badge variant="outline" className="border-primary/40 text-primary">
              <MessagesSquare className="mr-1.5 size-3.5" />
              One workspace
            </Badge>
            <h2 className="mt-5 text-2xl font-bold tracking-tight sm:text-3xl">
              Everything below is in the product today
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
              Eleven capabilities, one assistant. Start in Chat, drop into
              Andromeda when you need something verified, and keep the rest a
              click away.
            </p>
          </motion.div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {capabilities.map((c, i) => (
              <motion.div
                key={c.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: (i % 3) * 0.06 }}
                className={
                  c.primary
                    ? "omi-panel rounded-xl border-primary/25 p-5"
                    : "rounded-xl border border-border/70 bg-card p-5"
                }
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <c.icon className="size-5" />
                </div>
                <h3 className="mt-4 font-semibold tracking-tight">{c.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {c.body}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Principles — why the answers can be trusted. */}
      <section id="principles" className="border-t border-border/60 bg-secondary/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              An answer you can check
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
              Omi is built to be right before it is built to be fast.
            </p>
          </motion.div>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {principles.map((p, i) => (
              <motion.div
                key={p.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: i * 0.08 }}
                className="rounded-xl border border-border/70 bg-card p-6"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <p.icon className="size-5" />
                </div>
                <h3 className="mt-4 font-semibold tracking-tight">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {p.body}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing */}
      <section id="start" className="border-t border-border/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 text-center sm:px-6">
          <motion.h2 {...fadeUp} className="text-2xl font-bold tracking-tight sm:text-4xl">
            {BRAND.motto}
          </motion.h2>
          <motion.p
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.08 }}
            className="mx-auto mt-4 max-w-xl text-sm text-muted-foreground sm:text-base"
          >
            Ask your first question in under a minute. Omi will research it,
            show the sources, and tell you when it isn't sure.
          </motion.p>
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.16 }}>
            <Button asChild size="lg" className="mt-8 h-12 cursor-pointer rounded-xl px-8">
              <Link to={primaryHref}>
                {primaryLabel}
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </motion.div>
          <motion.p
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.22 }}
            className="mt-10 text-xs text-muted-foreground/60"
          >
            {BRAND.name} · {BRAND.creator}
          </motion.p>
        </div>
      </section>

      <footer className="border-t border-border/60 py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Omi Universal AI — {BRAND.creator}
      </footer>
    </div>
  );
}
