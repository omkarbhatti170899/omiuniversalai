import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import type { WorkspaceView } from "@/components/workspace/WorkspaceShell";
import { HomeView } from "@/components/workspace/HomeView";
import { MemoryView } from "@/components/workspace/MemoryView";
import { OmiSearchPanel } from "@/components/OmiSearchPanel";
import { useState, lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Phase 3 — code splitting by view.
 *
 * Only Home ships in the dashboard entry chunk. Every other workspace surface
 * is fetched the first time it is opened, so signing in and landing on Home
 * no longer downloads the image studio, the knowledge intelligence console,
 * the agents panel and the automation view up front. The user pays for a view
 * only when they ask for it — functionality is not reduced, only deferred.
 */
const KnowledgeView = lazy(() =>
  import("@/components/workspace/KnowledgeView").then((m) => ({
    default: m.KnowledgeView,
  })),
);
const KnowledgeIntelligenceView = lazy(() =>
  import("@/components/workspace/KnowledgeIntelligenceView").then((m) => ({
    default: m.KnowledgeIntelligenceView,
  })),
);
const FilesView = lazy(() =>
  import("@/components/workspace/FilesView").then((m) => ({ default: m.FilesView })),
);
const ProjectsView = lazy(() =>
  import("@/components/workspace/ProjectsView").then((m) => ({
    default: m.ProjectsView,
  })),
);
const SettingsView = lazy(() =>
  import("@/components/workspace/SettingsView").then((m) => ({
    default: m.SettingsView,
  })),
);
const EmotionsView = lazy(() =>
  import("@/components/workspace/EmotionsView").then((m) => ({
    default: m.EmotionsView,
  })),
);
const AutomationView = lazy(() =>
  import("@/components/workspace/AutomationView").then((m) => ({
    default: m.AutomationView,
  })),
);
const ImageStudioView = lazy(() =>
  import("@/components/workspace/ImageStudioView").then((m) => ({
    default: m.ImageStudioView,
  })),
);
const OmiAssistantPanel = lazy(() =>
  import("@/components/OmiAssistantPanel").then((m) => ({
    default: m.OmiAssistantPanel,
  })),
);
const OmiAgentsPanel = lazy(() =>
  import("@/components/OmiAgentsPanel").then((m) => ({ default: m.OmiAgentsPanel })),
);

/**
 * The one loading affordance for the whole workspace: a real spinner with a
 * spoken status, not a skeleton that mimics content and jumps when the real
 * layout arrives.
 */
function ViewFallback({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground"
    >
      <Loader2 className="size-5 animate-spin text-primary" />
      <p className="text-sm">Loading {label}…</p>
    </div>
  );
}

export default function Dashboard() {
  const [view, setView] = useState<WorkspaceView>("home");
  const [assistantDraft, setAssistantDraft] = useState<string | undefined>(
    undefined,
  );
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  /** §5 Projects: the project whose context the chat view operates in. */
  const [chatProjectId, setChatProjectId] = useState<Id<"omiProjects"> | null>(
    null,
  );
  /** Image Studio: which mode the studio opens in (Home shortcuts seed this). */
  const [imageMode, setImageMode] = useState<"generate" | "edit">("generate");

  const navigate = (next: WorkspaceView) => {
    setView(next);
    // Clear one-shot seeds once consumed by their target view.
    if (next !== "chat") setAssistantDraft(undefined);
    if (next !== "search") setSearchQuery(undefined);
  };

  const openImageStudio = (mode: "generate" | "edit") => {
    setImageMode(mode);
    navigate("image");
  };

  const handleSearchSubmit = (query: string) => {
    // Global top-bar search: route to Omi Search pre-filled.
    setSearchQuery(query);
    setAssistantDraft(undefined);
    setView("search");
  };

  const handleAskOmi = (query: string, mode: "chat" | "search") => {
    if (mode === "chat") {
      setAssistantDraft(query);
      setSearchQuery(undefined);
      setView("chat");
    } else {
      setSearchQuery(query);
      setAssistantDraft(undefined);
      setView("search");
    }
  };

  return (
    <WorkspaceShell
      view={view}
      onNavigate={navigate}
      onSearchSubmit={handleSearchSubmit}
    >
      <Suspense fallback={<ViewFallback label={VIEW_FALLBACK_LABELS[view]} />}>
        {view === "home" && (
          <HomeView
            onNavigate={navigate}
            onAskOmi={handleAskOmi}
            onOpenImageStudio={openImageStudio}
          />
        )}

        {view === "image" && (
          <ImageStudioView key={imageMode} initialMode={imageMode} />
        )}

        {view === "chat" && (
          <div className="mx-auto max-w-5xl">
            <OmiAssistantPanel
              initialDraft={assistantDraft}
              projectId={chatProjectId}
            />
          </div>
        )}

        {view === "projects" && (
          <ProjectsView
            onChatInProject={(projectId) => {
              setChatProjectId(projectId);
              setAssistantDraft(undefined);
              setView("chat");
            }}
          />
        )}

        {view === "agents" && (
          <div className="mx-auto max-w-5xl">
            <OmiAgentsPanel />
          </div>
        )}

        {view === "research" && (
          <div className="mx-auto max-w-4xl">
            <OmiSearchPanel initialQuery={searchQuery} />
          </div>
        )}

        {view === "search" && (
          <div className="mx-auto max-w-4xl">
            <OmiSearchPanel initialQuery={searchQuery} />
          </div>
        )}

        {view === "memory" && <MemoryView />}

        {view === "knowledge" && <KnowledgeView />}
        {view === "knowledge-intelligence" && <KnowledgeIntelligenceView />}

        {view === "files" && <FilesView />}

        {view === "emotions" && (
          <div className="mx-auto max-w-4xl">
            <EmotionsView />
          </div>
        )}

        {view === "tasks" && (
          <div className="mx-auto max-w-5xl">
            <OmiAgentsPanel />
          </div>
        )}

        {view === "automation" && <AutomationView />}

        {view === "settings" && <SettingsView />}
      </Suspense>
    </WorkspaceShell>
  );
}

const VIEW_FALLBACK_LABELS: Record<WorkspaceView, string> = {
  home: "Home",
  chat: "Chat with Omi",
  image: "Image Studio",
  projects: "Projects",
  agents: "Agents",
  research: "Research",
  knowledge: "Knowledge",
  "knowledge-intelligence": "Knowledge AI",
  memory: "Memory",
  files: "Files",
  tasks: "Tasks",
  automation: "Automation",
  emotions: "Emotions AI",
  search: "Andromeda",
  settings: "Settings",
};
