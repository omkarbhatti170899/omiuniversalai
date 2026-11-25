/**
 * OMI UNIVERSAL AI — auth redirect.
 * =============================================================================
 * The workspace is now entered directly. This route still exists so any existing
 * returnTo links and auth redirects resolve cleanly; it no longer shows a
 * sign-in/sign-up screen.
 *
 * Behaviour:
 *   • If a user can be signed in anonymously, do that and proceed.
 *   • Otherwise proceed to the workspace anyway, because the app is guest-first.
 *   • Preserve `returnTo` resolution from the old auth page.
 *
 * Authentication, ownership and authorization remain server-side. This page only
 * controls entry routing.
 */

import { useAuth } from "@/hooks/use-auth";
import { useNavigate, useSearchParams } from "react-router";
import { useEffect } from "react";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

/**
 * Replaces the old sign-in/sign-up screen with an automatic redirect into the
 * workspace. If anonymous sign-in is available on the backend, the app attempts
 * it; otherwise it still enters the workspace because Omi is now guest-first.
 */
export default function AuthPage({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const go = async () => {
      try {
        await signIn("anonymous");
      } catch {
        /* guest sign-in is best-effort: if it fails, still enter the workspace */
      }
      navigate(redirect, { replace: true });
    };

    go();
  }, [isLoading, signIn, navigate, redirect]);

  return null;
}

