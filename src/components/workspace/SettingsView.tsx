import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/use-auth";
import {
  Bot,
  Brain,
  ExternalLink,
  Globe,
  KeyRound,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router";

export function SettingsView() {
  const { user, isLoading } = useAuth();
  const providerStatus = useQuery(api.searchStatus.status);

  const searchReady =
    providerStatus !== undefined && providerStatus.some((p) => p.ready);
  const missingHints =
    providerStatus
      ?.filter((p) => !p.ready)
      .map((p) => p.hint)
      .join(" ") ?? "";

  const features = [
    { icon: MessageSquare, label: "Chat with Omi", desc: "Reasoning + transparent 'Why this answer' trails" },
    { icon: Bot, label: "Agents", desc: "Plan → approve → execute with full audit trail" },
    { icon: Globe, label: "Omi Search", desc: "Live web answers with citations (provider-independent)" },
    { icon: Sparkles, label: "Human Emotions AI", desc: "Emotion, sentiment, urgency and rant read-outs" },
    { icon: Brain, label: "Memory", desc: "User-controlled persistent context across devices" },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account, workspace features, and connected providers.
        </p>
      </div>

      {/* Account */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-4">
            <Avatar className="size-12">
              <AvatarFallback className="bg-primary/15 font-semibold text-primary">
                {(user?.name ?? user?.email ?? "O").slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {isLoading ? "Loading…" : (user?.name ?? user?.email ?? "Signed in")}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {user?.email ?? "Guest session"}
              </p>
            </div>
            <Badge variant="outline" className="shrink-0">
              {user?.isAnonymous ? "Guest" : "Member"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Providers */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Web-search provider</p>
              <p className="text-xs text-muted-foreground">
                {searchReady
                  ? "Connected — Omi Search is live."
                  : "Not connected — live web search is paused."}
              </p>
            </div>
            <Badge
              variant="outline"
              className={
                searchReady
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400"
              }
            >
              {searchReady ? "Connected" : "Setup required"}
            </Badge>
          </div>

          {!searchReady && (
            <div className="mt-4 space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">To connect:</p>
              <p>{missingHints || "Add EXA_API_KEY in the project's API Keys tab."}</p>
              <p className="flex items-center gap-1">
                Free key:
                <a
                  href="https://exa.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                >
                  exa.ai
                  <ExternalLink className="size-3" />
                </a>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Feature overview */}
      <Card>
        <CardContent className="p-5">
          <p className="text-sm font-semibold">Workspace features</p>
          <div className="mt-4 space-y-1">
            {features.map((f, i) => {
              const Icon = f.icon;
              return (
                <div key={f.label}>
                  {i > 0 && <Separator className="my-3" />}
                  <div className="flex items-start gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">{f.label}</p>
                      <p className="text-xs text-muted-foreground">{f.desc}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button asChild variant="ghost" className="cursor-pointer">
          <Link to="/">Back to landing page</Link>
        </Button>
      </div>
    </div>
  );
}
