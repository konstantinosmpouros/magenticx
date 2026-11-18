import { motion, type Variants } from "framer-motion";

import ArtifactsPage from "@/features/artifacts/components/ArtifactsPage";
import { canvasDocumentHref } from "@/shared/lib/canvasDocuments";

import { useChatWorkspaceContext } from "@/app/workspaceContext";

const EASE = [0.22, 1, 0.36, 1] as const;

// The same entrance and exit as Automations and Agents: over the chat, which
// holds still underneath, it rises and settles in, and sinks and fades out.
// Reduced motion: a plain fade.
const PAGE: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985 },
  shown: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease: EASE } },
  exit: { opacity: 0, y: 12, scale: 0.99, transition: { duration: 0.26, ease: "easeIn" } },
};
const PAGE_FADE: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

/**
 * The Artifacts page for the "/artifacts" route (plan 44): fills the shell's
 * content area (the sidebar stays) and slides in over the chat, like
 * AutomationsView. It only wires routing — the page itself, its data and its
 * actions live in `features/artifacts`.
 */
export default function ArtifactsView() {
  const { reduceMotion, navigate, userId } = useChatWorkspaceContext();

  return (
    <motion.div
      // z-30, not z-50 — see AutomationsView: the mobile sidebar is a fixed
      // sibling at z-40/z-50 and must paint over this page.
      className="absolute inset-0 z-30 origin-top bg-background"
      variants={reduceMotion ? PAGE_FADE : PAGE}
      initial="hidden"
      animate="shown"
      exit="exit"
    >
      <ArtifactsPage
        userId={userId ?? null}
        onOpenConversation={(conversationId) =>
          navigate(`/c/${encodeURIComponent(conversationId)}`)
        }
        onOpenCanvas={(conversationId, path) => navigate(canvasDocumentHref(conversationId, path))}
        onStartChat={() => navigate("/")}
      />
    </motion.div>
  );
}
