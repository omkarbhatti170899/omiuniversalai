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

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First visit gets the staged entrance; everyone else renders immediately.
  // Read lazily in the initialiser rather than in an effect: this is a
  // client-only SPA (no SSR, so no hydration mismatch is possible) and it
  // avoids a second render pass before the screen has anything to show.
  const [firstVisit] = useState(() => {
    try {
      const seen = localStorage.getItem(SEEN_KEY) === "1";
      localStorage.setItem(SEEN_KEY, "1");
      return !seen;
    } catch {
      /* storage blocked — treat as a returning user rather than blocking anyone */
      return false;
    }
  });
  const reduce = useReducedMotion();

  const staged = firstVisit && !reduce;
  // `d` is the per-step delay; 0 renders everything at once.
  const d = (step: number) => (staged ? step * 0.11 : 0);
  const rise = (step: number) => ({
    initial: staged ? { opacity: 0, y: 14 } : false,
    animate: { opacity: 1, y: 0 },
    transition: { duration: staged ? 0.55 : 0.001, delay: d(step), ease: [0.21, 0.6, 0.35, 1] as const },
  });

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

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
        <motion.button
          {...rise(0)}
          type="button"
          onClick={() => navigate("/")}
          className="group mx-auto flex cursor-pointer flex-col items-center text-center"
          aria-label={`${BRAND.name} — go to home`}
        >
          <OmiMark
            className="size-24 drop-shadow-[0_8px_40px_rgba(110,123,255,0.35)] transition-transform duration-500 group-hover:scale-[1.04] sm:size-28"
            animated={staged}
            title={BRAND.name}
          />
          <h1 className="mt-7 text-4xl font-bold leading-none tracking-[0.3em] text-[#F6F7FB] sm:text-5xl">
            OMI
          </h1>
          <p className="mt-3 text-[0.68rem] font-medium uppercase tracking-[0.42em] text-[#8B93AD]">
            {BRAND.descriptor}
          </p>
          <p className="mt-5 max-w-[19rem] text-sm leading-relaxed text-[#A8AEC4]">
            {BRAND.motto}
          </p>
          <p className="mt-2 text-[0.7rem] tracking-wide text-[#6C7490]">
            {BRAND.creator}
          </p>
        </motion.button>

        {/* The one way in. */}
        <motion.div {...rise(1)} className="mt-10">
          {step === "signIn" ? (
            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-3">
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
          ) : (
            <form onSubmit={handleOtpSubmit} className="flex flex-col gap-5">
              <input type="hidden" name="email" value={step.email} />
              <input type="hidden" name="code" value={otp} />

              <div className="text-center">
                <p className="text-sm text-[#F6F7FB]">Check your email</p>
                <p className="mt-1 text-xs text-[#8B93AD]">
                  We sent a 6-digit code to {step.email}
                </p>
              </div>

              <div className="flex justify-center">
                <InputOTP
                  value={otp}
                  onChange={setOtp}
                  maxLength={6}
                  disabled={isLoading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && otp.length === 6 && !isLoading) {
                      const form = (e.target as HTMLElement).closest("form");
                      form?.requestSubmit();
                    }
                  }}
                >
                  <InputOTPGroup>
                    {Array.from({ length: 6 }).map((_, index) => (
                      <InputOTPSlot key={index} index={index} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>

              {error ? (
                <p className="text-center text-sm text-[#F87171]" role="alert">
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                className="h-12 w-full cursor-pointer rounded-xl"
                disabled={isLoading || otp.length !== 6}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  <>
                    Verify code
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>

              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep("signIn")}
                disabled={isLoading}
                className="h-10 w-full cursor-pointer text-[#8B93AD] hover:text-[#F6F7FB]"
              >
                Use a different email
              </Button>
            </form>
          )}
        </motion.div>

        <motion.p
          {...rise(2)}
          className="mt-10 text-center text-[0.68rem] text-[#5A6076]"
        >
          Secured by{" "}
          <a
            href="https://freebuff.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-[#2C2C36] underline-offset-2 transition-colors hover:text-[#F6F7FB]"
          >
            freebuff.com
          </a>
        </motion.p>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
