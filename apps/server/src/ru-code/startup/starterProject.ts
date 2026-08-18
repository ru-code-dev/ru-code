// ru-code: the pre-made starter project.
//
// The installer creates a ready-to-use `<baseDir>/Project` folder (git-init +
// first commit) so the first launch has a workspace without auto-adopting the
// user's current working directory. On startup the app registers this fixed
// path instead of `cwd` (see serverRuntimeStartup.ts). Keep this dir name in
// sync with the `Project` folder the install script creates.

export const STARTER_PROJECT_DIRNAME = "Project";

/** The starter project's workspace root, `<baseDir>/Project`. */
export const resolveStarterProjectRoot = (baseDir: string, join: (...parts: string[]) => string) =>
  join(baseDir, STARTER_PROJECT_DIRNAME);
