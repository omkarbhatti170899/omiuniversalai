import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  Activity,
  BrainCircuit,
  Loader2,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useState } from "react";

type EmotionAnalysis = {
  _id: Id<"emotionAnalyses">;
  text: string;
  emotion: string;
  confidence: number;
  rantScore?: number;
  rantInterpretation?: string;
  sentiment?: string;
  sentimentScore?: number;
  urgency?: string;
  urgencyScore?: number;
  signalFields?: string;
  advice?: string;
  omiNote?: string;
  /** "ai" = classification model read · "heuristic" = local word/punctuation read */
  source?: string;
  _creationTime: number;
};

/** How a read-out was produced — shown honestly on every history entry. */
function ReadSourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const isAi = source === "ai";
  return (
    <Badge
      variant="outline"
      title={
        isAi
          ? "Read by a classification model through Omi's provider router."
          : "Read locally from word and punctuation signals — no model call."
      }
    >
      {isAi ? "model read" : "local read"}
    </Badge>
  );
}

const EXAMPLES = [
  "This is the third time I've contacted you and the deadline is tomorrow. I'm honestly exhausted.",
  "The new dashboard update is brilliant — setup took five minutes and everything just works.",
  "I'm not angry, I just want to understand why the export keeps failing before our audit.",
];

const URGENT_STYLES: Record<string, string> = {
  high: "bg-red-500/15 text-red-500 border-red-500/30",
  medium: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  low: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
};

function urgencyClass(urgency?: string): string {
  return URGENT_STYLES[(urgency ?? "").toLowerCase()] ?? URGENT_STYLES.medium;
}

function EmotionChip({ emotion }: { emotion: string }) {
  const key = emotion.toLowerCase();
  const color =
    key.includes("angry") || key.includes("frustrat")
      ? "bg-red-500/15 text-red-500 border-red-500/30"
      : key.includes("anxious") || key.includes("worr") || key.includes("confus")
        ? "bg-amber-500/15 text-amber-500 border-amber-500/30"
        : key.includes("delight") || key.includes("happy") || key.includes("relief") || key.includes("grate")
          ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
          : "bg-primary/15 text-primary border-primary/30";
  return (
    <Badge variant="outline" className={color}>
      {emotion}
    </Badge>
  );
}

export function EmotionsView() {
  const history = useQuery(api.emotions.listMine);
  const analyses = history ?? [];
  const analyze = useAction(api.emotionsAi.analyze);
  const removeAnalysis = useMutation(api.emotions.remove);

  // Same single source of truth as Settings: Emotion-aware mode is one setting.
  const settings = useQuery(api.omiSettings.get);
  const updateSettings = useMutation(api.omiSettings.update);
  const [savingMode, setSavingMode] = useState(false);
  const emotionAware = settings?.emotionAware ?? true;

  const toggleEmotionAware = async (next: boolean) => {
    setSavingMode(true);
    try {
      await updateSettings({ emotionAware: next });
      toast.success(
        next
          ? "Emotion-aware mode on — Omi adapts its tone in chat."
          : "Emotion-aware mode off — Omi answers plainly.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that preference.");
    } finally {
      setSavingMode(false);
    }
  };

  const [text, setText] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const isLoadingHistory = history === undefined;

  const handleAnalyze = async () => {
    if (text.trim().length < 2 || isAnalyzing) return;
    setIsAnalyzing(true);
    try {
      await analyze({ text });
      setText("");
      toast.success("Omi finished the emotional read-out.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Omi couldn't analyze that. Try again.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDelete = async (id: Id<"emotionAnalyses">) => {
    try {
      await removeAnalysis({ id });
      toast("Analysis removed.");
    } catch {
      toast.error("Couldn't remove that analysis.");
    }
  };

  return (
    <div className="space-y-8">
      {/* Emotion-aware mode — automatic tone reads in chat, user-controlled. */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <Card className="border-border/70 bg-card/60">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <Activity className="size-4 text-primary" />
                  Emotion-aware mode
                  <Badge
                    variant="outline"
                    className={
                      emotionAware
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "border-border bg-muted text-muted-foreground"
                    }
                  >
                    {emotionAware ? "Active" : "Off"}
                  </Badge>
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  When active, Omi reads the emotional signals in each chat
                  message and adapts its tone — without changing what it
                  answers. Read-outs are inferences from your wording (emotion,
                  sentiment, urgency), never knowledge of your inner state, and
                  they are not stored anywhere unless you opt in from Settings.
                </p>
              </div>
              <Switch
                checked={emotionAware}
                disabled={settings === undefined || savingMode}
                onCheckedChange={(next) => void toggleEmotionAware(next)}
                aria-label="Emotion-aware mode"
              />
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Analyzer */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sparkles className="size-5" />
              </div>
              <div>
                <CardTitle>Analyze a message</CardTitle>
                <CardDescription>
                  Omi detects emotion, sentiment, urgency, and rant level —
                  with a recommended next action. An analysis you run here is
                  always saved to your history below.
                </CardDescription>
              </div>
              <Activity className="ml-auto hidden size-5 text-muted-foreground/60 sm:block" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="message">Message to analyze</Label>
              <Textarea
                id="message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste a support message, chat, review, or spoken snippet…"
                className="min-h-28 resize-y"
                maxLength={2000}
                disabled={isAnalyzing}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleAnalyze();
                  }
                }}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>⌘/Ctrl + Enter to analyze</span>
                <span>{text.length}/2000</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="max-w-full truncate rounded-full border border-border/70 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  onClick={() => setText(ex)}
                  disabled={isAnalyzing}
                >
                  {ex.slice(0, 48)}…
                </button>
              ))}
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                className="cursor-pointer"
                onClick={() => void handleAnalyze()}
                disabled={isAnalyzing || text.trim().length < 2}
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Omi is reading the emotion…
                  </>
                ) : (
                  <>
                    <Send className="mr-2 size-4" />
                    Analyze with Omi
                  </>
                )}
              </Button>
              {text.trim().length >= 2 && (
                <Button
                  variant="ghost"
                  className="cursor-pointer"
                  onClick={() => setText("")}
                  disabled={isAnalyzing}
                >
                  Clear
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* History */}
      <motion.section
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight">History</h2>
            <p className="text-sm text-muted-foreground">
              Your last 50 analyses, newest first.
            </p>
          </div>
          {!isLoadingHistory && analyses.length > 0 && (
            <Badge variant="secondary">{analyses.length} saved</Badge>
          )}
        </div>

        {isLoadingHistory ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : analyses.length === 0 ? (
          <Card className="mt-6 border-dashed">
            <CardContent className="flex flex-col items-center py-12 text-center">
              <BrainCircuit className="size-8 text-muted-foreground/50" />
              <p className="mt-4 font-semibold">No analyses yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Run your first read-out above — Omi will save every analysis you
                run here. Automatic chat read-outs appear here only if you turn
                on “Save emotion read-outs to history” in Settings.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-6 space-y-4">
            {analyses.map((a: EmotionAnalysis) => (
              <Card key={a._id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <EmotionChip emotion={a.emotion} />
                    <Badge variant="outline" className={urgencyClass(a.urgency)}>
                      {a.urgency ?? "medium"} urgency
                      {typeof a.urgencyScore === "number"
                        ? ` · ${Math.round(a.urgencyScore)}`
                        : ""}
                    </Badge>
                    {a.sentiment && (
                      <Badge variant="secondary">
                        {a.sentiment}
                        {typeof a.sentimentScore === "number"
                          ? ` · ${a.sentimentScore.toFixed(2)}`
                          : ""}
                      </Badge>
                    )}
                    {typeof a.rantScore === "number" && (
                      <Badge variant="secondary">
                        rant {Math.round(a.rantScore)}/100
                      </Badge>
                    )}
                    <ReadSourceBadge source={a.source} />
                    <span className="ml-auto text-xs text-muted-foreground">
                      {Math.round((a.confidence ?? 0) * 100)}% confidence
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground">
                    "{a.text}"
                  </p>
                  {a.signalFields && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">Signals:</span>{" "}
                      {a.signalFields}
                    </p>
                  )}
                  {a.rantInterpretation && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">Rant read:</span>{" "}
                      {a.rantInterpretation}
                    </p>
                  )}
                  {a.advice && (
                    <p className="text-sm">
                      <span className="font-semibold">Next action:</span> {a.advice}
                    </p>
                  )}
                  {a.omiNote && (
                    <p className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs leading-relaxed">
                      <span className="font-semibold text-primary">Omi:</span>{" "}
                      {a.omiNote}
                    </p>
                  )}
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="cursor-pointer gap-2 text-muted-foreground hover:text-destructive"
                      onClick={() => void handleDelete(a._id)}
                    >
                      <Trash2 className="size-4" />
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </motion.section>
    </div>
  );
}
