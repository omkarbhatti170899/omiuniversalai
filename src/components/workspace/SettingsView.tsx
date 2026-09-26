import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";



import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import {
  Activity,
  Bot,
  Brain,
  Globe,
  Heart,
  MessageSquare,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

export function SettingsView() {
  const { user, isLoading } = useAuth();
  const providerStatus = useQuery(api.searchStatus.status);
  const health = useQuery(api.omiHealth.workspaceHealth);
  const ecosystem = useQuery(api.ecosystemStatus.status);

  // Human Emotions AI — the user's own on/off control for automatic tone reads.
  const settings = useQuery(api.omiSettings.get);
  const updateSettings = useMutation(api.omiSettings.update);
  const [savingEmotion, setSavingEmotion] = useState(false);
  const [savingKnowledge, setSavingKnowledge] = useState(false);

  /** §10/§11 — how chat consults the approved knowledge base. */
  const KNOWLEDGE_MODE_OPTIONS = [
    {
      id: "off",
      label: "Off",
      desc: "Chat ignores the knowledge base and uses general AI + web.",
    },
    {
      id: "prefer",
      label: "Prefer knowledge",
      desc: "Approved knowledge answers first; the web is used only when it can't.",
    },
    {
      id: "only",
      label: "🔒 Approved knowledge only",
      desc: "Answers come ONLY from approved internal knowledge. No web search; if evidence is missing, Omi says so and logs a gap.",
    },
    {
      id: "research",
      label: "🔎 Knowledge + research",
      desc: "Internal knowledge first, then Andromeda fills the gaps — always labelled INTERNAL vs EXTERNAL.",
    },
  ] as const;

  const setKnowledgeMode = async (mode: string) => {
    setSavingKnowledge(true);
    try {
      await updateSettings({ knowledgeMode: mode });
      toast.success(`Knowledge mode set to “${mode}”.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that preference.");
    } finally {
      setSavingKnowledge(false);
    }
  };

  const knowledgeMode = settings?.knowledgeMode ?? "prefer";

  const setEmotionSetting = async (
    patch: { emotionAware?: boolean; emotionHistory?: boolean },
  ) => {
    setSavingEmotion(true);
    try {
      await updateSettings(patch);
      if (patch.emotionAware !== undefined) {
        toast.success(
          patch.emotionAware
            ? "Emotion-aware mode on — Omi will adapt its tone."
            : "Emotion-aware mode off — Omi answers plainly.",
        );
      } else if (patch.emotionHistory !== undefined) {
        toast.success(
          patch.emotionHistory
            ? "Omi will save emotion read-outs to your history."
            : "Emotion read-outs are no longer saved automatically.",
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that preference.");
    } finally {
      setSavingEmotion(false);
    }
  };

  const emotionAware = settings?.emotionAware ?? true;
  const emotionHistory = settings?.emotionHistory ?? false;
  const emotionControlsDisabled = settings === undefined || savingEmotion;

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

      {/* Human Emotions AI — automatic tone awareness, under the user's control */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Heart className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Human Emotions AI</p>
              <p className="text-xs text-muted-foreground">
                Omi reads the emotional signals in your wording and adapts how
                it replies.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Emotion-aware mode</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Each message is read for tone (frustration, sadness, anger,
                  excitement, confusion, urgency) and Omi adjusts its style —
                  short and concrete when you sound frustrated, gentle when you
                  sound disappointed, calm and ordered when something reads as
                  anxious. This is an inference from your words, not knowledge
                  of how you feel, and it never changes <em>what</em> Omi
                  answers.
                </p>
              </div>
              <Switch
                checked={emotionAware}
                disabled={emotionControlsDisabled}
                onCheckedChange={(next) =>
                  void setEmotionSetting({ emotionAware: next })
                }
                aria-label="Emotion-aware mode"
              />
            </div>

            <Separator />

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  Save emotion read-outs to history
                  <span className="ml-2 align-middle text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                    off by default
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Inferred emotional data is sensitive, so automatic read-outs
                  are not stored. Turn this on to keep them in{" "}
                  <span className="text-foreground">Emotions AI → History</span>.
                  Manual analyses you run there are always saved, and you can
                  delete any entry at any time.
                </p>
              </div>
              <Switch
                checked={emotionHistory}
                disabled={emotionControlsDisabled || !emotionAware}
                onCheckedChange={(next) =>
                  void setEmotionSetting({ emotionHistory: next })
                }
                aria-label="Save emotion read-outs to history"
              />
            </div>
            {!emotionAware && (
              <p className="text-[11px] text-muted-foreground">
                Emotion-aware mode is off, so Omi is not reading tone at all and
                nothing can be saved.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Knowledge Intelligence mode (§10/§11) */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Knowledge Intelligence</p>
              <p className="text-xs text-muted-foreground">
                How ordinary chat questions consult the approved knowledge base.
                Source types are always labelled — internal and external are
                never blended silently.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {KNOWLEDGE_MODE_OPTIONS.map((o) => {
              const active = knowledgeMode === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  disabled={settings === undefined || savingKnowledge}
                  onClick={() => void setKnowledgeMode(o.id)}
                  aria-pressed={active}
                  className={`cursor-pointer rounded-lg border p-3 text-left transition-colors disabled:opacity-60 ${
                    active
                      ? "border-primary/50 bg-primary/10"
                      : "border-border/60 hover:border-border"
                  }`}
                >
                  <p className="text-sm font-medium">{o.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{o.desc}</p>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Semantic retrieval is an enhancement, not a requirement: without a
            configured embedding provider Omi uses keyword (BM25) search and says
            so — it never fakes a vector.
          </p>
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

      {/* OMI health — tool reliability + verification quality (Phase 11/13) */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Activity className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">OMI health & reliability</p>
              <p className="text-xs text-muted-foreground">
                Live metrics from your tool runs and verification passes.
              </p>
            </div>
          </div>

          {/* Phase 11 — improvement proposals (human-approved only, §11) */}
          {health !== undefined && health !== null && health.proposals.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Improvement proposals — for your approval
              </p>
              {health.proposals.map((p) => (
                <div
                  key={p.id}
                  className="rounded-lg border border-border/60 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-sm font-medium">{p.title}</p>
                    <Badge
                      variant="outline"
                      className={
                        p.severity === "action"
                          ? "shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-400"
                          : p.severity === "watch"
                            ? "shrink-0 border-sky-500/30 bg-sky-500/10 text-sky-400"
                            : "shrink-0 border-border bg-muted text-muted-foreground"
                      }
                    >
                      {p.severity === "action"
                        ? "Needs review"
                        : p.severity === "watch"
                          ? "Watch"
                          : "Info"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{p.detail}</p>
                  <p className="mt-1.5 text-xs text-foreground/90">
                    <span className="font-medium">Requested decision:</span> {p.ask}
                  </p>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground">
                Derived read-only from your live metrics (master plan §11:
                PROPOSE → TEST → VERIFY → APPROVE → DEPLOY). Omi never applies
                a change without your explicit approval.
              </p>
            </div>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border/60 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Vision (image understanding)
              </p>
              {health === undefined ? (
                <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
              ) : health === null ? (
                <p className="mt-2 text-sm text-muted-foreground">Sign in to see vision status.</p>
              ) : health.vision.available ? (
                <>
                  <p className="mt-2 text-sm font-medium">{health.vision.activeLabel}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Uploaded images are described and join your knowledge base.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-2 text-sm font-medium">Not configured — optional</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add a free GROQ_API_KEY in the API Keys tab to let Omi describe
                    uploaded images. Everything else keeps working without it.
                  </p>
                </>
              )}
            </div>
            <div className="rounded-lg border border-border/60 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                Verification quality
              </p>
              {health === undefined ? (
                <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
              ) : health === null || health.verification.checked === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Run an agent task to see verification metrics.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-2xl font-bold tracking-tight">
                    {health.verification.passRate}%
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      of {health.verification.checked} verified tasks passed
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {health.verification.pass} pass · {health.verification.warnings} warnings ·{" "}
                    {health.verification.failed} failed
                  </p>
                </>
              )}
            </div>
            <div className="rounded-lg border border-border/60 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                AI routing (active provider)
              </p>
              {health === undefined || health === null ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {health === undefined ? "Loading…" : "Sign in to see routing."}
                </p>
              ) : (
                <>
                  <p className="mt-2 text-sm font-medium">
                    {health.ai.providers.filter((p) => p.configured).map((p) => p.label).join(", ") ||
                      "None configured"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Tasks route to the best model per provider — free-first,
                    with automatic fallback.
                  </p>
                </>
              )}
            </div>
          </div>

          {health !== undefined && health !== null && health.toolMetrics.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tool reliability (last {health.toolMetrics.reduce((a, m) => a + m.total, 0)} runs)
              </p>
              {health.toolMetrics.map((m) => (
                <div
                  key={m.tool}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
                >
                  <p className="truncate text-sm font-medium">{m.tool}</p>
                  <div className="flex shrink-0 items-center gap-3 text-xs">
                    <span className="text-muted-foreground">{m.avgMs}ms avg</span>
                    <Badge
                      variant="outline"
                      className={
                        m.successRate >= 90
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : m.successRate >= 60
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                            : "border-red-500/30 bg-red-500/10 text-red-400"
                      }
                    >
                      {m.successRate}% success
                    </Badge>
                  </div>
</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ecosystem technologies (master plan §15–23/§31/§32) */}
      <Card>
        <CardContent className="p-5">
          <p className="text-sm font-semibold">Ecosystem technologies</p>
          <p className="mt-1 text-xs text-muted-foreground">
            What Omi actually uses from each ecosystem, its license, and its
            real cost — free/open things are active, everything metered is
            excluded or off by default.
          </p>
          <div className="mt-4 space-y-3">
            {(ecosystem ?? []).map((group) => (
              <details
                key={group.ecosystem}
                className="rounded-lg border border-border/60 p-3"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium">
                  <span>{group.ecosystem}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {group.counts.active} active · {group.counts.optional} optional ·{" "}
                    {group.counts.notApproved} excluded
                  </span>
                </summary>
                <div className="mt-3 space-y-2">
                  {group.entries.map((e) => (
                    <div
                      key={e.tech}
                      className="rounded-md border border-border/50 px-3 py-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 text-xs font-semibold">{e.tech}</p>
                        <Badge
                          variant="outline"
                          className={
                            e.status === "active"
                              ? "shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                              : e.status === "optional"
                                ? "shrink-0 border-sky-500/30 bg-sky-500/10 text-sky-400"
                                : "shrink-0 border-border bg-muted text-muted-foreground"
                          }
                        >
                          {e.status === "active"
                            ? "Active · $0"
                            : e.status === "optional"
                              ? "Optional"
                              : "Not approved"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{e.role}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground/80">
                        License: {e.license} · Cost: {e.cost}
                      </p>
                      {e.reason && (
                        <p className="mt-1 text-[10px] text-muted-foreground/80">
                          Why excluded: {e.reason}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
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
