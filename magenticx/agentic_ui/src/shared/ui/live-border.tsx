/**
 * The light that travels round a card while its work runs (a sub-agent, a
 * plan step, an agent-map node, an automation, a workflow node): a ring over
 * the card's edge and a blurred glow behind it, both turning. Render it as the
 * first child of a `.subagent-card` (or `.workflow-node`), only while the card
 * is live; the look and the motion live in styles/subagent.css.
 *
 * Written here rather than taken from a component library: it is two empty,
 * decorative spans whose whole job is the CSS — a still frame that cuts a
 * turning layer to shape, so the light moves on the compositor (plan 45).
 */
export function LiveBorder() {
  return (
    <>
      <span aria-hidden className="live-border-glow" />
      <span aria-hidden className="live-border-ring" />
    </>
  );
}
