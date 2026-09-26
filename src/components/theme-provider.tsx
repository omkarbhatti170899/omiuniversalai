import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Omi theme system (§13). Wraps next-themes so the rest of the app only ever
 * touches `useTheme()`. Dark is the default visual identity; System follows
 * the OS. The choice persists in localStorage under `omi-theme`.
 *
 * Only the `dark`/`light` class on <html> changes — every colour in the app
 * already comes from the oklch tokens in src/index.css, so switching theme
 * costs no re-render of any page content.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
