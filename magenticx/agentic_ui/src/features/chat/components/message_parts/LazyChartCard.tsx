import { lazy, Suspense } from "react";
import type { ChartBlock } from "@/shared/lib/types";
import { Skeleton } from "@/shared/ui/skeleton";

// Charts pull in recharts (~300 KB) and most conversations never draw one, so
// the card is its own chunk (plan 45), fetched the first time a chart shows.
const ChartCard = lazy(() => import("./ChartCard").then((m) => ({ default: m.ChartCard })));

/**
 * A chart block as it appears in an answer: the real ChartCard once its chunk
 * has loaded, and until then a skeleton about the card's size, so the text
 * below it doesn't jump when the chart arrives.
 */
export function LazyChartCard({ block }: { block: ChartBlock }) {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full rounded-2xl" />}>
      <ChartCard block={block} />
    </Suspense>
  );
}
