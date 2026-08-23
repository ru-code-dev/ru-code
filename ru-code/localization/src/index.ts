// Russian localization runtime helpers.
//
// Holds the runtime the bilingual UI needs: the locale switch, the display-string
// helpers the build transform injects (L / LT), and Russian plural forms (pluralRu
// / Lp) used by the hand-written plural seams. See ./locale.ts for the design.

export * from "./pluralRu.ts";
export * from "./locale.ts";
export * from "./serverToken.ts";
export * from "./durationUnits.ts";
