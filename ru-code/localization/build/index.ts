// Build-time entrypoint: the Vite/Rollup localization transform plugin.
// Consumed by apps/web and apps/server vite configs.
// @ts-expect-error - plain-JS build tooling, no types needed at the config layer.
export { ruCodeLocalizationPlugin } from "./vitePlugin.mjs";
