import { Loader } from "@/shared/ui/shadcn-io/loader";
import { cn } from "@/shared/lib/utils";

/**
 * What a code-split page shows while its chunk downloads (plan 45). Usually
 * never seen: the chunks are prefetched when the browser is idle. Composed from
 * the existing Loader rather than a new component.
 *
 * `overlay` covers its positioned parent, the way the pages over the chat
 * (Agents, Automations, …) do, so a loading page never shows the chat through
 * it; without it the fallback fills the viewport (Login, Share, Terms).
 */
export function PageFallback({ overlay = false }: { overlay?: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "flex items-center justify-center bg-background text-muted-foreground",
        overlay ? "absolute inset-0 z-30" : "min-h-svh",
      )}
    >
      <Loader />
    </div>
  );
}
