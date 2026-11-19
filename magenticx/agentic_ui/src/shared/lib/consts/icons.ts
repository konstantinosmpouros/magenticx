import {
  BarChart3,
  BookOpen,
  Bot,
  BrainCircuit,
  Building2,
  Compass,
  FlaskConical,
  Library,
  PenLine,
  Scale,
  Search,
  ShoppingBag,
  Sparkles,
  Telescope,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * Every agent icon the app can be asked to draw, by its Lucide name.
 *
 * An explicit map rather than `import * as Icons from "lucide-react"`: a
 * namespace import read by a runtime key cannot be tree-shaken, and it put all
 * ~1,500 Lucide icons (752 KB) into the first download (plan 45). The names an
 * agent can carry come from three places, and all of them are listed here:
 * - the builder's icon picker (`ICON_CHOICES` in the agent builder's MainSections);
 * - the starter templates (`features/agents/lib/agentTemplates/`);
 * - the platform agents' class attributes in the agents service
 *   (omni `BrainCircuit`, HR `Building2`, orthodox `BookOpen`, retail `ShoppingBag`).
 * A new icon choice must be added here as well, or it draws the fallback.
 */
export const AGENT_ICONS: Readonly<Record<string, LucideIcon>> = {
  BarChart3,
  BookOpen,
  Bot,
  BrainCircuit,
  Building2,
  Compass,
  FlaskConical,
  Library,
  PenLine,
  Scale,
  Search,
  ShoppingBag,
  Sparkles,
  Telescope,
  Wrench,
};

/**
 * Convert a backend-provided Lucide icon name into the actual icon component.
 * Falls back to `Building2` when the icon name is missing or unknown.
 */
export const mapIcon = (name: string | null | undefined): LucideIcon => {
  if (!name) {
    return Building2;
  }
  // Own keys only: a name like "constructor" or "__proto__" must not resolve
  // to something on Object.prototype.
  return Object.prototype.hasOwnProperty.call(AGENT_ICONS, name) ? AGENT_ICONS[name] : Building2;
};
