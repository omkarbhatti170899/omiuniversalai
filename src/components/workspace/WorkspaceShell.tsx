import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Bell,
  BookMarked,
  BookOpen,
  Bot,
  Brain,
  ChevronsLeft,
  ChevronsRight,
  Files,
  Globe,
  Home,
  Image as ImageIcon,
  ListChecks,
  LogOut,
  Menu,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  Workflow,
  FolderKanban,
} from "lucide-react";

export type WorkspaceView =
  | "home"
  | "chat"
  | "image"
  | "projects"
  | "agents"
  | "research"
  | "knowledge"
  | "knowledge-intelligence"
  | "memory"
  | "files"
  | "tasks"
  | "automation"
  | "emotions"
  | "search"
  | "settings";

type NavItem = {
  id: WorkspaceView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  ready: boolean;
};

/**
 * Grouping is the navigation hierarchy: what you do (create), what Omi
 * reasons with (intelligence), and what runs underneath (system).
 */
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Create",
    items: [
      { id: "home", label: "Home", icon: Home, ready: true },
      { id: "chat", label: "Chat with Omi", icon: MessageSquare, ready: true },
      { id: "image", label: "Image Studio", icon: ImageIcon, ready: true },
      { id: "projects", label: "Projects", icon: FolderKanban, ready: true },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { id: "search", label: "Andromeda", icon: Search, ready: true },
      { id: "knowledge-intelligence", label: "Knowledge AI", icon: BookMarked, ready: true },
      { id: "research", label: "Research", icon: Globe, ready: true },
      { id: "agents", label: "Agents", icon: Bot, ready: true },
      { id: "memory", label: "Memory", icon: Brain, ready: true },
      { id: "emotions", label: "Emotions AI", icon: Sparkles, ready: true },
    ],
  },
  {
    label: "System",
    items: [
      { id: "tasks", label: "Tasks", icon: ListChecks, ready: true },
      { id: "automation", label: "Automation", icon: Workflow, ready: true },
      { id: "files", label: "Files", icon: Files, ready: true },
      { id: "knowledge", label: "Knowledge", icon: BookOpen, ready: true },
      { id: "settings", label: "Settings", icon: Settings, ready: true },
    ],
  },
];

const VIEW_TITLES: Record<WorkspaceView, string> = {
  home: "Home",
  chat: "Chat with Omi",
  image: "Image Studio",
  projects: "Projects",
  agents: "Agents",
  research: "Research",
  knowledge: "Knowledge",
  "knowledge-intelligence": "Knowledge Intelligence",
  memory: "Memory",
  files: "Files",
  tasks: "Tasks",
  automation: "Automation",
  emotions: "Emotions AI",
  search: "Andromeda",
  settings: "Settings",
};

function OmiMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-white/10 bg-gradient-to-b from-white/[0.09] to-white/[0.02] text-[15px] font-semibold tracking-tight text-foreground shadow-[0_1px_0_0_oklch(1_0_0/6%)_inset]",
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-1 -bottom-px h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent"
      />
      O
    </span>
  );
}

function NavList({
  view,
  collapsed,
  onNavigate,
}: {
  view: WorkspaceView;
  collapsed: boolean;
  onNavigate: (view: WorkspaceView) => void;
}) {
  return (
    <>
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="pb-1">
          {!collapsed && (
            <p className="px-3 pb-1.5 pt-3 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
              {group.label}
            </p>
          )}
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!item.ready}
                  onClick={() => onNavigate(item.id)}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/50",
                    active
                      ? "bg-white/[0.06] font-medium text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.035] hover:text-foreground",
                    !item.ready && "cursor-not-allowed opacity-40 hover:bg-transparent",
                  )}
                >
                  {active && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full bg-primary"
                    />
                  )}
                  <Icon
                    className={cn(
                      "size-4 shrink-0 transition-colors",
                      active ? "text-primary" : "text-muted-foreground/80 group-hover:text-foreground",
                    )}
                  />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
    <div className="omi-ambient min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        {/* Sidebar (desktop) */}
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar/80 backdrop-blur-xl transition-[width] duration-200 ease-out md:flex",
            collapsed ? "w-[68px]" : "w-[248px]",
          )}
        >
          {/* Brand */}
          <div
            className={cn(
              "flex items-center gap-3 px-4 py-4",
              collapsed && "justify-center px-0",
            )}
          >
            <OmiMark />
            {!collapsed && (
              <div className="min-w-0 leading-tight">
                <p className="truncate text-[13px] font-semibold tracking-[0.18em]">
                  OMI
                </p>
                <p className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                  Universal AI
                </p>
              </div>
            )}
          </div>

          <div className="mx-3 h-px bg-sidebar-border" />

          {/* Nav */}
          <nav className="omi-scroll flex-1 overflow-y-auto px-2 pb-3">
            <NavList view={view} collapsed={collapsed} onNavigate={onNavigate} />
          </nav>

          {/* Identity footer */}
          <div className="mx-3 mb-3 rounded-xl border border-sidebar-border bg-white/[0.02] p-3">
            {collapsed ? (
              <p
                className="text-center text-[10px] uppercase tracking-widest text-muted-foreground"
                title="Created by Mr. Omkar Prakash Bhatti"
              >
                OPB
              </p>
            ) : (
              <>
                <p className="text-[11px] font-medium leading-snug text-foreground/90">
                  One intelligence, infinite possibilities.
                </p>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
                  Omi Universal AI was created by Mr. Omkar Prakash Bhatti.
                </p>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="mb-3 flex cursor-pointer items-center justify-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
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
          {/* Command bar */}
          <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl">
            <div className="flex h-14 items-center gap-2 px-3 sm:h-16 sm:gap-3 sm:px-5">
              {/* Mobile nav trigger */}
              <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="cursor-pointer md:hidden"
                  aria-label="Open navigation"
                  onClick={() => setMobileNavOpen(true)}
                >
                  <Menu className="size-5" />
                </Button>
                <SheetContent
                  side="left"
                  className="w-[268px] border-sidebar-border bg-sidebar p-0"
                >
                  <SheetHeader className="px-4 pb-2 pt-5">
                    <SheetTitle className="flex items-center gap-3 text-left text-[13px] font-semibold tracking-[0.18em]">
                      <OmiMark />
                      OMI
                    </SheetTitle>
                    <SheetDescription className="sr-only">
                      Omi workspace navigation
                    </SheetDescription>
                  </SheetHeader>
                  <nav className="flex flex-1 flex-col overflow-y-auto px-2 pb-4">
                    <NavList
                      view={view}
                      collapsed={false}
                      onNavigate={(next) => {
                        onNavigate(next);
                        setMobileNavOpen(false);
                      }}
                    />
                  </nav>
                </SheetContent>
              </Sheet>

              {/* Current section */}
              <span className="hidden shrink-0 text-sm font-medium lg:block">
                {VIEW_TITLES[view]}
              </span>
              <span className="hidden h-4 w-px shrink-0 bg-border lg:block" />

              {/* Command bar */}
              <div className="relative mx-auto w-full max-w-xl">
                <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/80" />
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
                  placeholder="Ask Omi or search your workspace…"
                  aria-label="Ask Omi or search your workspace"
                  className="h-10 rounded-xl border-border/70 bg-white/[0.03] pl-10 pr-16 text-sm placeholder:text-muted-foreground/70 focus-visible:border-primary/40"
                  maxLength={500}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                  <Kbd>Ctrl K</Kbd>
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
                <ThemeToggle className="text-muted-foreground hover:text-foreground" />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative cursor-pointer text-muted-foreground hover:text-foreground"
                      aria-label="Notifications"
                    >
                      <Bell className="size-4" />
                      <span className="absolute right-2 top-2 size-1.5 rounded-full bg-primary" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Notifications</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => onNavigate("tasks")}
                    >
                      <ListChecks className="size-4" />
                      Tasks &amp; approvals
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => onNavigate("automation")}
                    >
                      <Workflow className="size-4" />
                      Workflow runs
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1 py-1 outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50"
                      aria-label="Account menu"
                    >
                      <Avatar className="size-8">
                        <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                      <span className="hidden text-left leading-tight xl:block">
                        <span className="block max-w-32 truncate text-xs font-medium">
                          {user?.name ?? user?.email ?? "Signed in"}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500 align-middle" />
                          Online
                        </span>
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="truncate">
                      {user?.name ?? user?.email ?? "Signed in"}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => onNavigate("settings")}
                    >
                      <Settings className="size-4" />
                      Settings
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => onNavigate("memory")}
                    >
                      <Brain className="size-4" />
                      Memory &amp; privacy
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer text-destructive focus:text-destructive"
                      onClick={() => void handleSignOut()}
                    >
                      <LogOut className="size-4" />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden cursor-pointer text-muted-foreground hover:text-destructive sm:inline-flex"
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

          <footer className="border-t border-border/60 px-4 py-4 text-center text-[11px] text-muted-foreground/70 sm:px-6">
            Omi Universal AI · created by Mr. Omkar Prakash Bhatti ·{" "}
            <Link to="/" className="transition-colors hover:text-foreground">
              Ominnovations
            </Link>
          </footer>
        </div>
      </div>
    </div>
  );
}
