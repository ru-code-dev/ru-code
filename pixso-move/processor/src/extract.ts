// Unwrap a single fenced code block (``` … ```), else return the trimmed whole. The LLM is
// asked for the result only, but often wraps it in a fence — strip it so the stored result
// is the raw artifact. A body that itself contains a fence is not a single block, so it is
// returned whole. Pure.
const SINGLE_FENCE = /^```[^\n]*\n([\s\S]*?)\n?```$/;

export const extractText = (raw: string): { readonly text: string } => {
  const trimmed = raw.trim();
  const body = trimmed.match(SINGLE_FENCE)?.[1];
  if (body !== undefined && !body.includes("```")) {
    return { text: body };
  }
  return { text: trimmed };
};
