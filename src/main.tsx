import '@vly-ai/integrations';
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { MotionConfig } from "framer-motion";
import { RequireAuth } from "@/components/RequireAuth";
import { NetworkStatusBar } from "@/components/NetworkStatusBar";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";
import { OmiMark } from "@/components/brand/OmiMark";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

/**
 * Dismiss the inline branded splash (index.html) the moment React has painted.
 * Doing it here rather than on a timer is what guarantees the splash can never
 * outlive the app it is covering.
 */
function dismissSplash() {
  const el = document.getElementById("omi-splash");
  if (!el) return;
  el.classList.add("gone");
  window.setTimeout(() => el.remove(), 300);
}

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <OmiMark className="size-8 animate-pulse" />
        <span className="text-[0.6rem] font-medium uppercase tracking-[0.3em] text-muted-foreground">
          Omi
        </span>
      </div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Shown when VITE_CONVEX_URL is missing: a visible, actionable notice beats a
 *  permanently blank page. The URL is configured per host (vercel.json
 *  build.env / the Pages workflow); it is public, never a secret. */
function MissingBackendConfig() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md text-center">
        <OmiMark className="mx-auto size-10" />
        <h1 className="mt-4 text-base font-semibold">Omi is not connected yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This deployment is missing its backend URL. Set{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[0.75rem]">VITE_CONVEX_URL</code>{" "}
          to the Convex deployment URL (for example{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[0.75rem]">
            https://&lt;deployment&gt;.convex.cloud
          </code>
          ) and rebuild.
        </p>
      </div>
    </div>
  );
}

// Convex URL is a PUBLIC connection string by design (like a Firebase
// project id) — it identifies the backend, it is not a secret (§28). Secrets
// (Groq/DeepSeek/OpenAI keys) stay server-side in the Convex dashboard and
// are never compiled into the frontend.
const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string | undefined;

// Build the client lazily. Constructing it with a throwing fallback would run
// at MODULE scope — before React mounts and outside every error boundary — so a
// build with no VITE_CONVEX_URL shipped a permanently blank page. A missing
// value now renders an actionable notice instead (see MissingBackendConfig).
const convex = CONVEX_URL ? new ConvexReactClient(CONVEX_URL) : null;

// SPA deep links on static hosts (GitHub Pages): public/404.html catches the
// missed route, stashes it, and bounces here — restore the exact path before
// React Router mounts (basename below keeps URLs under /omiuniversalai/).
(function restoreSpaRoute() {
  try {
    const stashed = sessionStorage.getItem("omi-spa-redirect");
    if (!stashed) return;
    sessionStorage.removeItem("omi-spa-redirect");
    const target = new URL(stashed);
    const path = target.pathname + target.search + target.hash;
    if (path !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(null, "", path);
    }
  } catch {
    /* storage blocked — root route renders, no harm */
  }
})();



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


dismissSplash();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      {convex === null ? (
        <MissingBackendConfig />
      ) : (
        <>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      {/* §22/§27: every Framer Motion animation respects the OS
          prefers-reduced-motion setting — user choice wins over decoration. */}
      <MotionConfig reducedMotion="user">
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        disableTransitionOnChange
        storageKey="omi-theme"
      >
        <ConvexAuthProvider client={convex}>
          {/* §18: app-wide connectivity state, on every route (landing, auth,
              dashboard). Never renders while online. */}
          <NetworkStatusBar />
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            <RouteSyncer />
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route
                  path="/auth"
                  element={<AuthPage redirectAfterAuth="/dashboard" />}
                />
                <Route
                  path="/dashboard"
                  element={
                    <RequireAuth>
                      <Dashboard />
                    </RequireAuth>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
          <Toaster />
        </ConvexAuthProvider>
      </ThemeProvider>
      </MotionConfig>
        </>
      )}
    </RootErrorBoundary>
  </StrictMode>,
);

// Phase 8 (PWA): offline-capable service worker. Registered in production
// builds only — the managed dev/preview session must never be served stale
// caches, and registering against dev HMR plumbing risks cache poisoning.
// A failed registration is logged, never thrown: it must not break the app.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Relative to BASE_URL so the SW scope covers the app on any host —
    // root deployments (managed preview) and subpath hosts (GitHub Pages
    // /omiuniversalai/) alike. Scope limits caching to app URLs, never
    // foreign paths, and never touches Convex API calls (network-only).
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => {
        console.warn("[PWA] Service worker registration failed:", err);
      });
  });
}
