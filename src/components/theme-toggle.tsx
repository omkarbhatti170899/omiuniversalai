import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Theme switcher (§13): Dark (default) · Light · System. Reachable from every
 * top-level surface, keyboard-operable, and persisted by the provider.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const current = theme ?? "system";
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("cursor-pointer", className)}
          aria-label="Change theme"
          title="Theme: dark, light, or system"
        >
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem className="cursor-pointer" onSelect={() => setTheme("dark")}>
          <Moon className="mr-2 size-4" />
          Dark
          {current === "dark" && <span className="ml-auto text-primary">•</span>}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" onSelect={() => setTheme("light")}>
          <Sun className="mr-2 size-4" />
          Light
          {current === "light" && <span className="ml-auto text-primary">•</span>}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" onSelect={() => setTheme("system")}>
          <Monitor className="mr-2 size-4" />
          System
          {current === "system" && <span className="ml-auto text-primary">•</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
