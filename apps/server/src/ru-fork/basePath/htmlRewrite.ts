// ru-fork: rewrite the bundled index.html and webmanifest at
// request time so a single Vite build can be served under any
// `--base-url` prefix. The web client reads the prefix from
// `window.__RU_FORK_RUNTIME__.basePath`, which this module
// injects into the served HTML.
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

const ABSOLUTE_ATTR_RE = /\b(href|src|srcset)="(\/[^"/][^"]*)"/g;
const PROTOCOL_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const escapeForScript = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\u003c");

export const rewriteIndexHtmlForBasePath = (bytes: Uint8Array, basePath: string): Uint8Array => {
  const html = decoder.decode(bytes);
  const runtimeScript = `<script>window.__RU_FORK_RUNTIME__=Object.freeze({basePath:"${escapeForScript(basePath)}"});</script>`;
  let rewritten = html;
  if (basePath.length > 0) {
    rewritten = rewritten.replace(ABSOLUTE_ATTR_RE, (match, attr: string, value: string) => {
      if (value.startsWith("//")) return match;
      if (PROTOCOL_PREFIX.test(value)) return match;
      if (value === basePath || value.startsWith(`${basePath}/`)) return match;
      return `${attr}="${basePath}${value}"`;
    });
  }
  rewritten = rewritten.replace(/<head>/i, `<head>${runtimeScript}`);
  return encoder.encode(rewritten);
};

const MANIFEST_ABS_RE = /"(id|start_url|scope|src)":(\s*)"(\/[^"]*)"/g;

export const rewriteWebmanifestForBasePath = (bytes: Uint8Array, basePath: string): Uint8Array => {
  if (basePath.length === 0) return bytes;
  const text = decoder.decode(bytes);
  const rewritten = text.replace(
    MANIFEST_ABS_RE,
    (match, key: string, gap: string, value: string) => {
      if (value.startsWith("//")) return match;
      if (value === basePath || value.startsWith(`${basePath}/`)) return match;
      return `"${key}":${gap}"${basePath}${value}"`;
    },
  );
  return encoder.encode(rewritten);
};
