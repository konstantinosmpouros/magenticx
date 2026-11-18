/**
 * The Artifacts page's URL (plan 44), in one place.
 *
 *   /artifacts    every file of the user's — uploads and the files agents
 *                 presented — across conversations
 *
 * Prefix-matched like the other pages, so a later sub-route
 * (`/artifacts/...`) counts as the same page for the shell.
 */

export const ARTIFACTS_PATH = "/artifacts";

/** Whether a pathname is the Artifacts page (not merely starts with the word). */
export const isArtifactsPath = (pathname: string): boolean =>
  pathname === ARTIFACTS_PATH || pathname.startsWith(`${ARTIFACTS_PATH}/`);
