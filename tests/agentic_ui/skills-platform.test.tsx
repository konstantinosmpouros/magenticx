// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Platform skills in the Skills tab (plan 44): the document skills that ship
 * with mAgenticX and are on for every deep agent.
 *
 * Pinned here:
 * - the contract keeps only safe values (an https upstream link, string
 *   fields) and drops nameless rows;
 * - the hook reads the list once, a SKILL.md on demand and once per visit, and
 *   surfaces failures for a retry instead of throwing;
 * - the view shows each skill as Platform + Always on with its source, version,
 *   licence and file count, offers no remove or toggle, keeps the upstream link
 *   outside the toggle button, and opens a read-only SKILL.md;
 * - the hub row leads to that view, and the Agent skills page names them as
 *   always on.
 */

const { api } = vi.hoisted(() => ({
  api: {
    getPlatformSkills: vi.fn(),
    getPlatformSkillDetail: vi.fn(),
    searchCatalogue: vi.fn(),
  },
}));
vi.mock("@/shared/lib/api", () => api);

import { usePlatformSkills } from "@/features/settings/hooks/usePlatformSkills";
import PlatformSkillsView from "@/features/settings/components/profile_parts/PlatformSkillsView";
import SkillsTab from "@/features/settings/components/profile_parts/SkillsTab";
import { PlatformSkillDetailSchema, PlatformSkillListSchema } from "@/shared/lib/schemas";
import type { PlatformSkill } from "@/shared/lib/types";

const COMMIT = "e4bb5d960d87126ff3b3a8af1a104b7db67560ba";

const skill = (name: string, overrides: Partial<PlatformSkill> = {}): PlatformSkill => ({
  name,
  description: `Work with ${name} files.`,
  licence: "Apache-2.0",
  sourceLabel: "anthropics/skills",
  sourceCommit: COMMIT,
  upstreamUrl: `https://github.com/anthropics/skills/tree/${COMMIT}/skills/${name}`,
  fileCount: 12,
  ...overrides,
});

const noMotion = () => ({});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.searchCatalogue.mockResolvedValue({
    results: [],
    total: 0,
    limit: 10,
    offset: 0,
    remoteEnabled: true,
  });
});

describe("the contract", () => {
  it("maps the wire rows and drops what it cannot trust", () => {
    const rows = PlatformSkillListSchema.parse([
      {
        name: "pdf",
        description: "PDFs",
        licence: "Apache-2.0",
        source_label: "anthropics/skills",
        source_repo: "https://github.com/anthropics/skills",
        source_commit: COMMIT,
        upstream_url: "javascript:alert(1)",
        file_count: 9,
      },
      { description: "nameless" },
    ]);
    expect(rows).toEqual([
      {
        name: "pdf",
        description: "PDFs",
        licence: "Apache-2.0",
        sourceLabel: "anthropics/skills",
        sourceCommit: COMMIT,
        upstreamUrl: null,
        fileCount: 9,
      },
    ]);
    expect(PlatformSkillListSchema.parse({ not: "a list" })).toEqual([]);
    const detail = PlatformSkillDetailSchema.parse({ name: "pdf", content: "---\nname: pdf\n---\n" });
    expect(detail.content).toContain("name: pdf");
    expect(detail.licence).toBeNull();
  });
});

describe("usePlatformSkills", () => {
  it("reads the list once and a SKILL.md once per visit", async () => {
    api.getPlatformSkills.mockResolvedValue([skill("docx"), skill("pdf")]);
    api.getPlatformSkillDetail.mockResolvedValue({ ...skill("pdf"), content: "# pdf" });
    const { result } = renderHook(() => usePlatformSkills());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.skills.map((s) => s.name)).toEqual(["docx", "pdf"]);

    act(() => {
      result.current.loadDetail("pdf");
      result.current.loadDetail("pdf");
    });
    await waitFor(() => expect(result.current.details.pdf?.content).toBe("# pdf"));
    act(() => result.current.loadDetail("pdf"));
    expect(api.getPlatformSkills).toHaveBeenCalledTimes(1);
    expect(api.getPlatformSkillDetail).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed list for a retry", async () => {
    api.getPlatformSkills.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([skill("xlsx")]);
    const { result } = renderHook(() => usePlatformSkills());
    await waitFor(() => expect(result.current.error).toBe("down"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.skills.map((s) => s.name)).toEqual(["xlsx"]));
    expect(result.current.error).toBeNull();
  });

  it("keeps a failed SKILL.md read retryable", async () => {
    api.getPlatformSkills.mockResolvedValue([skill("pdf")]);
    api.getPlatformSkillDetail
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce({ ...skill("pdf"), content: "# pdf" });
    const { result } = renderHook(() => usePlatformSkills());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.loadDetail("pdf"));
    await waitFor(() => expect(result.current.detailErrors.pdf).toBe("nope"));
    act(() => result.current.loadDetail("pdf"));
    await waitFor(() => expect(result.current.details.pdf?.content).toBe("# pdf"));
    expect(result.current.detailErrors.pdf).toBeUndefined();
  });
});

describe("PlatformSkillsView", () => {
  const state = (overrides = {}) => ({
    skills: [skill("pdf")],
    loading: false,
    error: null,
    retry: vi.fn(),
    details: {},
    detailErrors: {},
    isDetailLoading: () => false,
    loadDetail: vi.fn(),
    ...overrides,
  });

  it("shows a platform skill as built in, with its provenance and no controls to change it", () => {
    render(<PlatformSkillsView platform={state()} cardMotion={noMotion} prefersReducedMotion />);
    expect(screen.getByText("pdf")).toBeTruthy();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Always on")).toBeTruthy();
    expect(screen.getByText("anthropics/skills")).toBeTruthy();
    expect(screen.getByText(COMMIT.slice(0, 7))).toBeTruthy();
    expect(screen.getByText("Apache-2.0")).toBeTruthy();
    expect(screen.getByText("12 files")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();

    // The upstream link is reachable on its own, not nested in the toggle.
    const link = screen.getByRole("link", { name: /view source/i });
    expect(link.getAttribute("href")).toBe(skill("pdf").upstreamUrl);
    expect(link.closest("button")).toBeNull();
  });

  it("opens a read-only SKILL.md on demand", () => {
    const loadDetail = vi.fn();
    const { rerender } = render(
      <PlatformSkillsView platform={state({ loadDetail })} cardMotion={noMotion} prefersReducedMotion />,
    );
    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(loadDetail).toHaveBeenCalledWith("pdf");

    rerender(
      <PlatformSkillsView
        platform={state({ loadDetail, details: { pdf: { ...skill("pdf"), content: "---\nname: pdf\n---\n# PDF" } } })}
        cardMotion={noMotion}
        prefersReducedMotion
      />,
    );
    expect(screen.getByText(/# PDF/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says when the tier is off, and offers a retry on failure", () => {
    const { rerender } = render(
      <PlatformSkillsView platform={state({ skills: [] })} cardMotion={noMotion} prefersReducedMotion />,
    );
    expect(screen.getByText(/switched off on this server/i)).toBeTruthy();

    const retry = vi.fn();
    rerender(
      <PlatformSkillsView
        platform={state({ skills: [], error: "down", retry })}
        cardMotion={noMotion}
        prefersReducedMotion
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });
});

describe("SkillsTab", () => {
  it("leads from the hub to the platform skills and names them on the Agent skills page", async () => {
    api.getPlatformSkills.mockResolvedValue([skill("docx"), skill("pdf")]);
    const props = {
      mySkills: [],
      onRefreshMySkills: vi.fn().mockResolvedValue(undefined),
      agents: [],
    };
    const { unmount } = render(<SkillsTab {...props} />);
    const row = await screen.findByRole("button", { name: /platform skills/i });
    await waitFor(() => expect(within(row).getByText("2 always on")).toBeTruthy());
    fireEvent.click(row);
    expect(await screen.findByText("docx")).toBeTruthy();
    expect(screen.getAllByText("Platform")).toHaveLength(2);
    unmount();

    render(<SkillsTab {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /agent skills/i }));
    expect(await screen.findByText("docx, pdf")).toBeTruthy();
  });
});
