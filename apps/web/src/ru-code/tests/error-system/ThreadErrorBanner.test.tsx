import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "../../../components/chat/ThreadErrorBanner";

const ERROR_TEXT = "Qwen provider failed to start the turn.";

describe("ThreadErrorBanner", () => {
  it("renders nothing when there is no error", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} />)).toBe("");
  });

  it("renders the error text inside the alert description", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={ERROR_TEXT} />);

    expect(markup).toContain(ERROR_TEXT);
    expect(markup).toContain('data-slot="alert-description"');
  });

  it("keeps AlertDescription in the content column, not the icon column (#3017 guard)", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={ERROR_TEXT} />);

    // Alert buckets its children: recognized descriptions land in the
    // width-constrained content column, everything else (like the icon) in
    // the narrow `size-4` icon column. Regression #3017 wrapped the
    // AlertDescription in a Tooltip, hiding its slot so the text collapsed
    // into the icon column and rendered one letter per line.
    // ru-code: fixture rot fix (F2/F3) — Alert's icon-column class list changed
    // upstream (no longer contains the literal "size-4 shrink-0" substring);
    // "[&>svg]:size-4" is the stable marker of the icon column today.
    const iconColumnIndex = markup.indexOf("&gt;svg]:size-4");
    const contentColumnIndex = markup.indexOf("flex min-w-0 flex-1 flex-col");
    const descriptionIndex = markup.indexOf('data-slot="alert-description"');
    const errorIndex = markup.indexOf(ERROR_TEXT);

    expect(iconColumnIndex).toBeGreaterThanOrEqual(0);
    expect(contentColumnIndex).toBeGreaterThan(iconColumnIndex);
    // The description slot (and the error text) must sit inside the content
    // column region, i.e. after it opens — not back in the icon column.
    expect(descriptionIndex).toBeGreaterThan(contentColumnIndex);
    expect(errorIndex).toBeGreaterThan(descriptionIndex);
  });

  it("renders a dismiss control when onDismiss is provided", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={ERROR_TEXT} onDismiss={() => {}} />,
    );

    expect(markup).toContain('data-slot="alert-action"');
    expect(markup).toContain('aria-label="Dismiss error"');
  });
});
