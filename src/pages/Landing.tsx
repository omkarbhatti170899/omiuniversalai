import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Gauge,
  MessageSquareHeart,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.55, ease: [0.21, 0.6, 0.35, 1] as const },
};

const signals = [
  {
    icon: BrainCircuit,
    title: "Emotion detection",
    body: "Omi reads the human feeling inside every message — frustration, anxiety, relief — before your team even replies.",
  },
  {
    icon: Gauge,
    title: "Rant vs. complaint",
    body: "Know instantly whether you're handling an actionable issue or an emotional release, and respond the right way.",
  },
  {
    icon: Activity,
    title: "Sentiment & urgency",
    body: "Scores for tone and urgency, so the most human-critical conversations float to the top of the queue.",
  },
];

export default function Landing() {
  const { isLoading, isAuthenticated } = useAuth();

  const primaryHref = isAuthenticated ? "/dashboard" : "/auth";
  const primaryLabel = isAuthenticated ? "Open your workspace" : "Start free";

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      {/* Navbar */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BrainCircuit className="size-5" />
            </span>
            <span className="text-base font-bold tracking-tight">
              Ominnovations
              <span className="text-primary"> Intelligence</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#signals" className="transition-colors hover:text-foreground">
              How it reads emotion
            </a>
            <a href="#omi" className="transition-colors hover:text-foreground">
              Meet Omi
            </a>
          </nav>
          <Button asChild className="cursor-pointer">
            <Link to={primaryHref}>{primaryLabel}</Link>
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Ambient glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(600px circle at 50% -10%, oklch(0.68 0.15 262 / 0.22), transparent 65%)",
          }}
        />
        <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center px-4 pb-20 pt-20 text-center sm:px-6 sm:pt-28">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <Badge
              variant="outline"
              className="gap-2 border-primary/40 bg-primary/10 px-3 py-1 text-primary"
            >
              <Sparkles className="size-3.5" />
              Human Emotions AI — powered by Omi
            </Badge>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08 }}
            className="mt-6 max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl"
          >
            AI that understands how your{" "}
            <span className="text-primary">customers feel</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.16 }}
            className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg"
          >
            Ominnovations Intelligence is the AI workspace for support and
            operations teams. Paste any message and Omi decodes the emotion
            behind it — or ask Omi to search the live web and answer with
            citations. Empathy, speed, and consistency in one place.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.24 }}
            className="mt-8 flex flex-col gap-3 sm:flex-row"
          >
            <Button asChild size="lg" className="cursor-pointer">
              <Link to={primaryHref}>
                {primaryLabel}
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="cursor-pointer">
              <Link to="/auth">Sign in with email code</Link>
            </Button>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.35 }}
            className="mt-4 text-xs text-muted-foreground"
          >
            No passwords. One-time email codes, or continue as guest.
          </motion.p>
        </div>
      </section>

      {/* Signals */}
      <section id="signals" className="border-t border-border/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <motion.div {...fadeUp} className="text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Every message has a signal. Omi finds it.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
              One paste in, a full emotional read-out — saved to your workspace
              history.
            </p>
          </motion.div>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {signals.map((s, i) => (
              <motion.div
                key={s.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: i * 0.08 }}
                className="rounded-xl border border-border/70 bg-card p-6"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="size-5" />
                </div>
                <h3 className="mt-4 font-bold tracking-tight">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Omi */}
      <section id="omi" className="border-t border-border/60 bg-secondary/40">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-20 sm:px-6 md:grid-cols-2">
          <motion.div {...fadeUp}>
            <Badge variant="outline" className="border-primary/40 text-primary">
              Meet Omi
            </Badge>
            <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              Your AI guide to every human conversation
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground sm:text-base">
              Omi sits inside your workspace, reading emotion the way a great
              teammate would — noticing the pressure behind a deadline, the
              frustration behind a repeated ticket, the relief after a fix.
              Agents get a clear read and a recommended next action in seconds.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "Primary emotion with confidence score",
                "Recommended next action for the agent",
                "Live web search with cited answers",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <MessageSquareHeart className="mt-0.5 size-4 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
            <Button asChild className="mt-8 cursor-pointer">
              <Link to={primaryHref}>
                Try it now
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </motion.div>

          <motion.div
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.1 }}
            className="rounded-xl border border-border/70 bg-card p-6"
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sample read-out
            </p>
            <div className="mt-4 space-y-3 text-sm">
              <div className="rounded-lg border border-border/60 bg-background/60 p-3 text-muted-foreground">
                "This is the third time I've contacted you and the deadline is
                tomorrow. I'm honestly exhausted."
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-primary">Exhausted → frustrated</span>
                <span className="text-xs text-muted-foreground">92% confidence</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Negative sentiment</Badge>
                <Badge variant="destructive">High urgency · 86</Badge>
                <Badge variant="secondary">Rant 34/100</Badge>
              </div>
              <p className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs leading-relaxed text-foreground">
                <span className="font-semibold text-primary">Omi:</span>{" "}
                Acknowledge the three previous contacts first — that history is
                the emotional weight here. Then confirm a concrete fix time
                before the deadline.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-border/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 text-center sm:px-6">
          <motion.h2 {...fadeUp} className="text-2xl font-bold tracking-tight sm:text-4xl">
            Hear what your customers are really saying
          </motion.h2>
          <motion.p
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.08 }}
            className="mx-auto mt-4 max-w-xl text-sm text-muted-foreground sm:text-base"
          >
            Sign in with a one-time email code and run your first emotion
            analysis in under a minute.
          </motion.p>
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.16 }}>
            <Button asChild size="lg" className="mt-8 cursor-pointer">
              <Link to={primaryHref}>
                {primaryLabel}
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </motion.div>
        </div>
      </section>

      <footer className="border-t border-border/60 py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Ominnovations Intelligence · Human Emotions AI
      </footer>
    </div>
  );
}
