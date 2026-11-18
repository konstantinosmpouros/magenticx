import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";

/**
 * An error boundary around one section of a page — the workflow view's
 * graph, timeline and details, the document canvas beside the chat — so a
 * crash in one, or its lazy chunk failing to load, leaves the rest standing. A class component because React has
 * no hook for boundaries; "Try again" re-mounts the section.
 */
type Props = { label: string; children: ReactNode; className?: string };
type State = { error: Error | null };

export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(`Section crashed: ${this.props.label}`, error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className={
          this.props.className ??
          "flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground"
        }
      >
        <CircleAlert className="h-5 w-5 text-destructive" aria-hidden />
        <p>The {this.props.label} could not be shown.</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-full px-3 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Try again
        </button>
      </div>
    );
  }
}
