/**
 * The app's code-split entry points (plan 45): one dynamic import per route
 * page and per heavy on-demand panel, so the first download carries only the
 * chat. `App.tsx` and the shell wrap these in `React.lazy`.
 *
 * They live in one list so `prefetchRouteChunks` can warm every chunk once the
 * browser is idle after the first paint: by the time someone opens Agents or
 * Settings the code is usually already cached, and the Suspense fallback
 * never shows. Calling a loader twice is free — the module is fetched once.
 */

export const loadAutomationsView = () => import("@/pages/AutomationsView");
export const loadArtifactsView = () => import("@/pages/ArtifactsView");
export const loadWorkflowView = () => import("@/pages/WorkflowView");
export const loadWorkflowBuilderView = () => import("@/pages/WorkflowBuilderView");
export const loadAgentsView = () => import("@/pages/AgentsView");
export const loadAgentsGallery = () => import("@/features/agents/pages/AgentsGallery");
export const loadAgentPage = () => import("@/features/agents/pages/AgentPage");
export const loadAgentBuilderPage = () => import("@/features/agents/pages/AgentBuilderPage");
export const loadLogin = () => import("@/pages/Login");
export const loadSharedConversationPage = () => import("@/pages/SharedConvPage");
export const loadTermsAndConditions = () => import("@/pages/TermsAndConditions");
export const loadPrivacyPolicy = () => import("@/pages/PrivacyPolicy");
export const loadNotFound = () => import("@/pages/NotFound");
export const loadProfilePanel = () => import("@/features/settings/components/ProfilePanel");
export const loadAttachmentPreviewPanel = () =>
  import("@/features/attachments/components/AttachmentPreviewPanel");

/** What a signed-in person is likely to open next, warmed in this order. */
const PREFETCH_ORDER = [
  loadProfilePanel,
  loadAttachmentPreviewPanel,
  loadAgentsView,
  loadAgentsGallery,
  loadAutomationsView,
  loadArtifactsView,
  loadAgentPage,
  loadWorkflowView,
  loadAgentBuilderPage,
  loadWorkflowBuilderView,
];

/** How long to wait for an idle moment before warming the chunks anyway. */
const IDLE_TIMEOUT_MS = 4000;

/**
 * Fetch the route chunks in the background, one after another, when the main
 * thread is idle — never competing with the first paint or a streaming answer.
 * A failed fetch is ignored: the route simply loads on demand later.
 */
export function prefetchRouteChunks(): () => void {
  let cancelled = false;
  const run = async () => {
    for (const load of PREFETCH_ORDER) {
      if (cancelled) return;
      try {
        await load();
      } catch {
        // Offline or a stale deploy: the lazy route retries when opened.
      }
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => void run(), { timeout: IDLE_TIMEOUT_MS });
    return () => {
      cancelled = true;
      window.cancelIdleCallback(handle);
    };
  }
  // Safari has no requestIdleCallback: a plain delay after load does the same job.
  const timer = window.setTimeout(() => void run(), IDLE_TIMEOUT_MS / 2);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
