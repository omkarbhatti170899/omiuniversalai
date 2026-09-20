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
  Globe,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router";

export function SettingsView() {
  const { user, isLoading } = useAuth();
  const providerStatus = useQuery(api.searchStatus.status);

  const searchReady =
    providerStatus !== undefined && providerStatus.some((p) => p.ready);

  const features = [
    { icon: MessageSquare, label: "Chat with Omi", desc: "Reasoning + transparent 'Why this answer' trails" },
    { icon: Bot, label: "Agents", desc: "Plan → approve → execute with full audit trail" },
    { icon: Globe, label: "Andromeda", desc: "Multi-source meta-search: parallel retrieval, provenance, citations — zero cost" },
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

      {/* Andromeda sources — provider/cost status dashboard (spec §31) */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Globe className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Andromeda — search sources</p>
              <p className="text-xs text-muted-foreground">
                {searchReady
                  ? "Orchestrating free/open sources in parallel — every result carries provenance and citations."
                  : "No search source is reachable right now."}
              </p>
            </div>
            <Badge
              variant="outline"
              className={
                searchReady
                  ? "shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-400"
              }
            >
              {searchReady ? "Connected" : "Degraded"}
            </Badge>
          </div>

          <div className="mt-4 space-y-2">
            {(providerStatus ?? []).map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{p.cost}</p>
                </div>
                <Badge
                  variant="outline"
                  className={
                    p.ready
                      ? "shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-400"
                  }
                >
                  {p.ready ? "Ready" : "Unavailable"}
                </Badge>
              </div>
            ))}
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Zero mandatory paid dependency: every registered source is a
            free/open keyless API. Paid engines may exist only as optional
            adapters — none are registered, so none can silently bill.
          </p>
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
