/**
 * OMI UNIVERSAL AI — premium workspace entry.
 * =============================================================================
 * The first screen is now the workspace, not a landing page and not a sign-in
 * screen. Its job is simple: state who Omi is, then get the visitor into the
 * experience immediately.
 *
 * The three things this screen must do:
 *   5s  — “This is Omi Universal AI.”              → mark, name, tagline
 *   10s — what it is, and where to go next        → shortcuts
 *   15s — the prompt is the center of the experience → “Ask Omi anything…”
 *
 * Nothing here replaces the backend. Chat, Andromeda, research, images,
 * knowledge, memory, agents and automation are launched from this screen into
 * the existing workspace routes.
 */

import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router";
import {
  MessageSquare,
  Search,
  Globe,
  Brain,
  BookOpen,
  FileText,
  Image as ImageIcon,
  Eye,
  Bot,
  Workflow,
  Sparkles,
  FolderOpen,
} from "lucide-react";
import { BRAND, OmiMark } from "@/components/brand/OmiMark";
import { OmiAmbientField } from "@/components/brand/OmiAmbientField";

const CATEGORIES = [
  {
    label: "Talk to Omi",
    items: [
      { icon: MessageSquare, label: "AI Chat", to: "/dashboard?view=chat" },
      { icon: Search, label: "Andromeda", to: "/dashboard?view=search" },
      { icon: Globe, label: "Deep Research", to: "/dashboard?view=research" },
    ],
  },
  {
    label: "Create",
    items: [
      { icon: ImageIcon, label: "Image Generation", to: "/dashboard?view=image&mode=generate" },
      { icon: ImageIcon, label: "Image Editing", to: "/dashboard?view=image&mode=edit" },
      { icon: Eye, label: "Vision", to: "/dashboard?view=chat" },
    ],
  },
  {
    label: "Organize",
    items: [
      { icon: BookOpen, label: "Knowledge AI", to: "/dashboard?view=knowledge" },
      { icon: Brain, label: "Memory", to: "/dashboard?view=memory" },
      { icon: FolderOpen, label: "Projects", to: "/dashboard?view=projects" },
    ],
  },
  {
    label: "Automate",
    items: [
      { icon: Bot, label: "AI Agents", to: "/dashboard?view=agents" },
      { icon: Workflow, label: "Automation", to: "/dashboard?view=automation" },
      { icon: FileText, label: "File Analysis", to: "/dashboard?view=files" },
    ],
  },
];

const SHORTCUTS = [
  ...CATEGORIES.flatMap((c) =>
    c.items.map((item) => ({
      icon: item.icon,
      label: item.label,
      to: item.to,
      category: c.label,
    }))
  ),
];

function ShortcutCard({ icon: Icon, label, to, index }: {
  icon: typeof MessageSquare;
  label: string;
  to: string;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.02 * index, ease: [0.21, 0.6, 0.35, 1] as const }}
      whileHover={{ y: -2 }}
      className="group flex items-center gap-3 rounded-xl border border-border/40 bg-card/60 px-3.5 py-3 transition-colors hover:bg-card hover:border-primary/30"
    >
      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
        <Icon className="size-4.5" />
      </div>
      <span className="text-sm font-medium text-foreground">{label}</span>
    </motion.div>
  );
}

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07070c] text-foreground">
      <OmiAmbientField />

      {/* Subtle top glow */}
      <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 size-[900px] rounded-full bg-primary/10 blur-[120px] opacity-40" aria-hidden="true" />

      {/* Header */}
      <header className="relative z-10 flex h-16 items-center justify-between px-5 sm:px-8">
        <Link
          to="/dashboard"
          className="flex items-center gap-2.5"
          aria-label={`${BRAND.name} — go to workspace`}
        >
          <OmiMark className="size-7" title={BRAND.name} />
          <span className="flex flex-col leading-none">
            <span className="text-[0.95rem] font-bold tracking-[0.2em]">OMI</span>
            <span className="mt-0.5 text-[0.55rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              {BRAND.descriptor}
            </span>
          </span>
        </Link>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">One intelligence. Infinite possibilities.</span>
          <span className="hidden sm:inline sm:block">·</span>
          <span className="sm:hidden">Omi Universal AI</span>
        </div>
      </header>

      {/* Main stage */}
      <main className="relative z-10 mx-auto flex max-w-6xl flex-col items-center justify-center px-4 pb-24 pt-20 text-center sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.21, 0.6, 0.35, 1] as const }}
          className="mx-auto flex max-w-xl flex-col items-center"
        >
          {/* Mark */}
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.08, ease: [0.21, 0.6, 0.35, 1] as const }}
          >
            <OmiMark
              className="size-22 drop-shadow-[0_12px_60px_rgba(110,123,255,0.35)] sm:size-26"
              animated
              title={BRAND.name}
            />
          </motion.div>

          {/* Brand line */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.16, ease: [0.21, 0.6, 0.35, 1] as const }}
            className="mt-5 text-[0.62rem] font-medium uppercase tracking-[0.42em] text-muted-foreground"
          >
            {BRAND.descriptor}
          </motion.p>

          {/* Title */}
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.22, ease: [0.21, 0.6, 0.35, 1] as const }}
            className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl"
          >
            OMI <span className="text-primary">Universal AI</span>
          </motion.h1>

          {/* Motto */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.28, ease: [0.21, 0.6, 0.35, 1] as const }}
            className="mt-3 text-sm font-medium text-foreground/80 sm:text-base"
          >
            One intelligence. Infinite possibilities.
          </motion.p>

          {/* Central prompt */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.34, ease: [0.21, 0.6, 0.35, 1] as const }}
            className="mt-9 flex w-full flex-col items-center gap-2"
          >
            <div className="group relative flex w-full items-center rounded-2xl border border-border/40 bg-card/40 px-5 py-4 text-left shadow-2xl ring-1 ring-border/20">
              <span className="pointer-events-none text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Ask Omi anything…
              </span>
              <span className="pointer-events-none ml-auto text-[0.6rem] uppercase tracking-widest text-muted-foreground/50">
                try · “latest news” · “describe this image” · “summarize my files”
              </span>
            </div>
            <p className="text-[0.62rem] text-muted-foreground/60">
              Chat · Search · Research · Images · Knowledge · Memory · Agents · Automation
            </p>
          </motion.div>

          {/* Shortcuts */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.42, ease: [0.21, 0.6, 0.35, 1] as const }}
            className="mt-2 w-full"
          >
            {CATEGORIES.map((category) => (
              <div key={category.label} className="mt-6">
                <p className="ml-1 text-[0.6rem] font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
                  {category.label}
                </p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {category.items.map((shortcut, index) => (
                    <ShortcutCard
                      key={shortcut.label}
                      icon={shortcut.icon}
                      label={shortcut.label}
                      to={shortcut.to}
                      index={index}
                    />
                  ))}
                </div>
              </div>
            ))}
          </motion.div>
        </motion.div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/30 py-6 text-center text-[0.6rem] text-muted-foreground/50">
        {BRAND.name} · {BRAND.creator}
      </footer>
    </div>
  );
}
