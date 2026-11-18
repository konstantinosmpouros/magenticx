/**
 * The byline of the open document (its version, author, date and history),
 * as a React context. The byline renders inside the editor, under the title
 * (`CanvasBlockFrame`), or above the text when the document has no title; a
 * context reaches it there without threading props through Plate's render
 * pipeline. Outside the canvas the value is null and no byline renders.
 */
import { createContext } from "react";

import type { CanvasBylineValue } from "@/shared/lib/types";

export const CanvasBylineContext = createContext<CanvasBylineValue | null>(null);
