import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import {
  Bell,
  BookOpen,
  Bot,
  Brain,
  ChevronsLeft,
  ChevronsRight,
  Files,
  Globe,
  Home,
  ListChecks,
  LogOut,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";

export type WorkspaceView =
  | "home"
  | "chat"
  | "projects"
  | "agents"
  | "research"
  | "knowledge"
  | "memory"
  | "files"
  | "tasks"
  | "emotions"
  | "search"
  | "settings";

type NavItem = {
  id: WorkspaceView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  ready: boolean;
};

const NAV: NavItem[] = [
  { id: "home", label: "Home", icon: Home, ready: true },
  { id: "chat", label: "Chat with Omi", icon: MessageSquare, ready: true },
  { id: "agents", label: "Agents", icon: Bot, ready: true },
  { id: "research", label: "Research", icon: Globe, ready: true },
  { id: "memory", label: "Memory", icon: Brain, ready: true },
  { id: "emotions", label: "Emotions AI", icon: Sparkles, ready: true },
  { id: "search", label: "Andromeda", icon: Search, ready: true },
  { id: "tasks", label: "Tasks", icon: ListChecks, ready: true },
  { id: "files", label: "Files", icon: Files, ready: true },
  { id: "knowledge", label: "Knowledge", icon: BookOpen, ready: true },
  { id: "settings", label: "Settings", icon: Settings, ready: true },
];

export function WorkspaceShell({
  view,
  onNavigate,
  onSearchSubmit,
  children,
}: {
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
  onSearchSubmit: (query: string) => void;
  children: React.ReactNode;
}) {
  const { user, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");

  // Ctrl/Cmd + K focuses the global search input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("omi-global-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleSubmitGlobal = () => {
    const q = globalQuery.trim();
    if (q.length < 2) return;
    onSearchSubmit(q);
    setGlobalQuery("");
  };

  const handleSignOut = async () => {
    await signOut();
    window.location.href = "/";
  };

  const initials = useMemo(() => {
    const name = user?.name ?? user?.email ?? "O";
    return name.slice(0, 2).toUpperCase();
  }, [user]);

  return (
    <div className="dark flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border/60 bg-card/40 transition-[width] duration-200 md:flex",
          collapsed ? "w-[72px]" : "w-60",
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/60 font-bold text-primary-foreground">
            O
          </span>
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-extrabold tracking-wide">OMI</p>
              <p className="truncate text-[10px] uppercase tracking-widest text-muted-foreground">
                Universal AI
              </p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={!item.ready}
                onClick={() => onNavigate(item.id)}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "border border-primary/40 bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  !item.ready && "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Footer card */}
        {!collapsed && (
          <div className="mx-3 mb-3 rounded-xl border border-border/60 bg-gradient-to-b from-primary/10 to-transparent p-4">
            <p className="text-sm font-semibold leading-snug">
              A better tomorrow, built with intelligence.
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">OMI</p>
          </div>
        )}

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="mb-3 flex cursor-pointer items-center justify-center gap-2 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronsRight className="size-4" />
          ) : (
            <>
              <ChevronsLeft className="size-4" />
              Collapse
            </>
          )}
        </button>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            {/* Mobile logo */}
            <Link to="/" className="flex items-center gap-2 md:hidden">
              <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/60 text-sm font-bold text-primary-foreground">
                O
              </span>
            </Link>

            <span className="hidden text-sm text-muted-foreground lg:block">
              One Intelligence. Infinite Possibilities.
            </span>

            {/* Global search */}
            <div className="relative mx-auto w-full max-w-xl">
              <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="omi-global-search"
                value={globalQuery}
                onChange={(e) => setGlobalQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSubmitGlobal();
                  }
                }}
                placeholder="Search anything… (projects, files, agents, knowledge)"
                className="h-10 rounded-xl pl-10 pr-14"
                maxLength={500}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                <Kbd>Ctrl K</Kbd>
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="relative cursor-pointer"
                aria-label="Notifications"
                onClick={() => onNavigate("tasks")}
              >
                <Bell className="size-4" />
              </Button>

              <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
                <Avatar className="size-8">
                  <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <div className="hidden leading-tight sm:block">
                    <p className="max-w-32 truncate text-xs font-semibold">
                      {user?.name ?? user?.email ?? "Signed in"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500 align-middle" />
                      Online
                    </p>
                  </div>
                )}
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="cursor-pointer text-muted-foreground hover:text-destructive"
                aria-label="Sign out"
                onClick={() => void handleSignOut()}
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
