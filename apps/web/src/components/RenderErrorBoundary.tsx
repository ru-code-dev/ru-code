import { Component, type ReactNode } from "react";

// ru-code: plugins — (A13, A12 findings R1-H1/R1-H2) the function `fallback` and the `onError` callback below.

/**
 * `fallback` may be a NODE or a FUNCTION of the caught
 * error, and `onError` fires once when the boundary first catches.
 *
 * Both additions exist for the plugin seam (`ru-code/plugins/renderSafety.tsx`): a plugin's panel
 * body must show the author WHICH error killed it, and the host must report the failure through
 * `reportPluginProblem` exactly once. The two existing callers (`ChatMarkdown`,
 * `HighlightedSearchLine`) pass a plain node and no `onError`, so they are unaffected.
 */
export type RenderErrorFallback = ReactNode | ((error: unknown) => ReactNode);

export class RenderErrorBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly fallback: RenderErrorFallback;
    readonly onError?: (error: unknown) => void;
  },
  { readonly failed: boolean; readonly error: unknown }
> {
  override state: { readonly failed: boolean; readonly error: unknown } = {
    failed: false,
    error: undefined,
  };

  /** Guards `onError` against React's double-invoke under StrictMode. */
  private reported = false;

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown) {
    if (this.reported) return;
    this.reported = true;
    this.props.onError?.(error);
  }

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    const { fallback } = this.props;
    return typeof fallback === "function" ? fallback(this.state.error) : fallback;
  }
}
