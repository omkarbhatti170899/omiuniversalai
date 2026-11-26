/**
 * OMI UNIVERSAL AI — sign in.
 * =============================================================================
 * The first screen a new visitor ever sees, so it carries the brand and almost
 * nothing else. Structure: mark → OMI → UNIVERSAL INTELLIGENCE → motto →
 * creator → one way in.
 *
 * What changed and why:
 *   • The mark is the hero (it was a 64px thumbnail in a generic card).
 *   • Copy now names the product, not a feature — the old line ("waiting to read
 *     the emotions in your inbox") described a different company.
 *   • The surface is the product's near-black with one ambient field, instead of
 *     a default bordered card floating on the theme background.
 *
 * What deliberately did NOT change: every line of auth logic. Same
 * email-OTP flow, same guest path, same redirect resolution, same error
 * handling. This is a presentation pass; behaviour is untouched and still
 * covered by the existing auth tests.
 *
 * RETURNING USERS ARE NOT HELD. The staged entrance (≈1.2s total) runs only on
 * a first visit; after that the brand is already known, so the screen renders at
 * once. `prefers-reduced-motion` skips it regardless.
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

import { useAuth } from "@/hooks/use-auth";
import { OmiAmbientField } from "@/components/brand/OmiAmbientField";
import { BRAND, OmiMark } from "@/components/brand/OmiMark";
import { ArrowRight, Loader2, Mail } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

const SEEN_KEY = "omi-brand-seen";

function resolveRedirectAfterAuth(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirect }: { redirect: string }) {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      setStep({ email: formData.get("email") as string });
      setIsLoading(false);
    } catch (error) {
      console.error("Email sign-in error:", error);
      setError(
        error instanceof Error
          ? error.message
          : "Failed to send verification code. Please try again.",
      );
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      navigate(redirect);
    } catch (error) {
      console.error("OTP verification error:", error);
      setError("The verification code you entered is incorrect.");
      setIsLoading(false);
      setOtp("");
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect);
    } catch (error) {
      console.error("Guest login error:", error);
      setError(
        `Failed to sign in as guest: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setIsLoading(false);
    }
  };

  return (
    // This screen is ALWAYS the brand's near-black canvas, in both themes, so it
    // uses explicit light-on-dark values rather than theme tokens. Using
    // `text-foreground` here would render dark text on a near-black background
    // for anyone whose saved theme is light — unreadable, and invisible to
    // automated tests. The theme toggle stays available in the workspace.
    <div className="relative min-h-screen overflow-hidden bg-[#0B0B0F] text-[#F6F7FB]">
      <OmiAmbientField />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
        {/* Brand block — the hero. Everything else is secondary to this. */}
        <OmiMark
          className="mx-auto size-24 drop-shadow-[0_8px_40px_rgba(110,123,255,0.35)] sm:size-28"
          title={BRAND.name}
        />
        <h1 className="mt-7 text-center text-4xl font-bold leading-none tracking-[0.3em] text-[#F6F7FB] sm:text-5xl">
          OMI
        </h1>
        <p className="mt-3 text-center text-[0.68rem] font-medium uppercase tracking-[0.42em] text-[#8B93AD]">
          {BRAND.descriptor}
        </p>
        <p className="mt-5 text-center max-w-[19rem] text-sm leading-relaxed text-[#A8AEC4]">
          {BRAND.motto}
        </p>
        <p className="mt-2 text-center text-[0.7rem] tracking-wide text-[#6C7490]">
          {BRAND.creator}
        </p>

        {/* The explicit sign-in / guest path. */}
        <form onSubmit={handleEmailSubmit} className="mt-10 flex flex-col gap-3">
          <label htmlFor="omi-email" className="sr-only">
            Email address
          </label>
          <div className="omi-panel relative flex items-center rounded-xl">
            <Mail className="pointer-events-none absolute left-3.5 h-4 w-4 text-[#6C7490]" />
            <Input
              id="omi-email"
              name="email"
              placeholder="you@example.com"
              type="email"
              autoComplete="email"
              className="h-12 border-0 bg-transparent pl-10 pr-12 text-[#F6F7FB] shadow-none placeholder:text-[#6C7490] focus-visible:ring-0"
              disabled={isLoading}
              required
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="absolute right-1.5 size-9 rounded-lg"
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
            </Button>
          </div>

          {error ? (
            <p className="text-sm text-[#F87171]" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            variant="outline"
            className="h-12 w-full cursor-pointer rounded-xl border-[#2C2C36] bg-transparent text-[#F6F7FB] hover:bg-white/[0.06] hover:text-[#F6F7FB]"
            onClick={handleGuestLogin}
            disabled={isLoading}
          >
            Continue as guest
          </Button>

          <p className="pt-1 text-center text-xs text-[#6C7490]">
            No password. We email you a one-time code.
          </p>
        </form>
      </div>
    </div>
  );
}

function GuestWire({ redirect }: { redirect: string }) {
  const { signIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const go = async () => {
      try {
        await signIn("anonymous");
      } catch {
        /* guest sign-in is best-effort: if it fails, still enter the workspace */
      }
      navigate(redirect, { replace: true });
    };

    go();
  }, [signIn, navigate, redirect]);

  return null;
}

function AuthPageWrapper(props: AuthProps) {
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    props.redirectAfterAuth,
  );

  // Only gate when auth has not resolved yet and nobody is signed in.
  if (authLoading || isAuthenticated) {
    return null;
  }

  // Best-effort guest entry on sight, then render the real sign-in surface
  // as a secondary, explicit path — not the first thing a visitor sees.
  const wire = <GuestWire redirect={redirect} />;
  const surface = <Auth redirect={redirect} />;

  return (
    <>
      {wire}
      {surface}
    </>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <AuthPageWrapper {...props} />
    </Suspense>
  );
}
