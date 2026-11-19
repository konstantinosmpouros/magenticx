import { describe, expect, it } from "vitest";

import { AGENT_ICONS, mapIcon } from "@/shared/lib/consts/icons";
import { AGENT_TEMPLATES } from "@/features/agents/lib/agentTemplates";

/**
 * Agent icons come from an explicit map (plan 45), not the whole Lucide set,
 * so every name an agent can carry must be in it — otherwise that agent
 * silently draws the Building2 fallback.
 */
describe("agent icon map", () => {
  // The platform agents' icons, set as class attributes in the agents service
  // (deep_agents/omni_agent, langgraph_agents/{hr_policies,orthodox,retail}_agent_v1).
  const PLATFORM_ICONS = ["BrainCircuit", "Building2", "BookOpen", "ShoppingBag"];
  // The builder's icon picker (MainSections ICON_CHOICES) and its default.
  const PICKER_ICONS = [
    "Bot",
    "BrainCircuit",
    "Telescope",
    "Sparkles",
    "Compass",
    "Scale",
    "FlaskConical",
    "Library",
    "PenLine",
    "Wrench",
    "BarChart3",
    "Search",
  ];

  it.each([...PLATFORM_ICONS, ...PICKER_ICONS])("draws %s", (name) => {
    expect(AGENT_ICONS[name]).toBeDefined();
    expect(mapIcon(name)).toBe(AGENT_ICONS[name]);
  });

  it("covers every starter template's icon", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(Object.keys(AGENT_ICONS)).toContain(template.icon);
    }
  });

  it("falls back to Building2 for a missing or unknown name", () => {
    const Building2 = AGENT_ICONS.Building2;
    expect(mapIcon(undefined)).toBe(Building2);
    expect(mapIcon(null)).toBe(Building2);
    expect(mapIcon("")).toBe(Building2);
    expect(mapIcon("NotAnIcon")).toBe(Building2);
    expect(mapIcon("constructor")).toBe(Building2);
    expect(mapIcon("__proto__")).toBe(Building2);
  });
});
