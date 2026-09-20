import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import type { WorkspaceView } from "@/components/workspace/WorkspaceShell";
import { HomeView } from "@/components/workspace/HomeView";
import { MemoryView } from "@/components/workspace/MemoryView";
import { KnowledgeView } from "@/components/workspace/KnowledgeView";
import { FilesView } from "@/components/workspace/FilesView";
import { SettingsView } from "@/components/workspace/SettingsView";
import { EmotionsView } from "@/components/workspace/EmotionsView";
import { AutomationView } from "@/components/workspace/AutomationView";
import { OmiSearchPanel } from "@/components/OmiSearchPanel";
import { OmiAssistantPanel } from "@/components/OmiAssistantPanel";
import { OmiAgentsPanel } from "@/components/OmiAgentsPanel";
import { useState } from "react";

export default function Dashboard() {
  const [view, setView] = useState<WorkspaceView>("home");
  const [assistantDraft, setAssistantDraft] = useState<string | undefined>(
    undefined,
  );
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);

  const navigate = (next: WorkspaceView) => {
    setView(next);
    // Clear one-shot seeds once consumed by their target view.
    if (next !== "chat") setAssistantDraft(undefined);
    if (next !== "search") setSearchQuery(undefined);
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
      {view === "home" && <HomeView onNavigate={navigate} onAskOmi={handleAskOmi} />}

      {view === "chat" && (
        <div className="mx-auto max-w-5xl">
          <OmiAssistantPanel initialDraft={assistantDraft} />
        </div>
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
    </WorkspaceShell>
  );
}
