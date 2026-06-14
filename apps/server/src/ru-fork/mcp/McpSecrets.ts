// ru-fork: split inbound draft vars (plaintext secret values) into
// ServerSecretStore + secret refs, and materialize refs back to plaintext for
// probing/overlay. Catalog-level secret vars are keyed per-server; per-project
// secret values are keyed per-binding. Plain vars stay plaintext. See
// mcp-vars-redesign.md §D5.

import type {
  McpServerVar,
  McpServerVarDraft,
  McpServerId,
  McpVarValue,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type SecretStoreError, ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { mcpVarSecretName } from "./McpSecretNames.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** A var value is a secret reference (vs a plain string) when it's an object. */
function isSecretRef(value: McpVarValue): value is { readonly secretRef: string } {
  return typeof value === "object";
}

/**
 * Persist each catalog-level secret var's plaintext and return vars holding only
 * refs. Plain vars keep their string value; a null value (per-project hole) stays
 * null. A secret var with a null value (per-project secret, no catalog default)
 * also stays null — its value is supplied per binding.
 */
export const splitServerVars = (
  serverId: McpServerId,
  draftVars: ReadonlyArray<McpServerVarDraft>,
  existingVars: ReadonlyArray<McpServerVar>,
): Effect.Effect<ReadonlyArray<McpServerVar>, SecretStoreError, ServerSecretStore> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const existingByName = new Map(existingVars.map((variable) => [variable.name, variable]));
    const result: McpServerVar[] = [];
    for (const draft of draftVars) {
      const base = {
        name: draft.name,
        secret: draft.secret,
        perProject: draft.perProject,
        required: draft.required,
        origin: "user" as const,
      };
      // Keep an untouched secret: reuse the existing stored ref instead of overwriting. Only valid
      // when the existing var is a secret holding a ref (not a per-project hole / plain value).
      if (draft.secret && draft.keepSecret === true) {
        const previousValue = existingByName.get(draft.name)?.value;
        if (previousValue !== null && previousValue !== undefined && isSecretRef(previousValue)) {
          result.push({ ...base, value: previousValue });
          continue;
        }
        // No prior ref to keep (renamed / new) ⇒ fall through to treat `value` normally.
      }
      if (draft.value === null) {
        result.push({ ...base, value: null });
        continue;
      }
      if (draft.secret) {
        const secretName = mcpVarSecretName({ serverId, varName: draft.name });
        yield* secretStore.set(secretName, textEncoder.encode(draft.value));
        result.push({ ...base, value: { secretRef: secretName } });
      } else {
        result.push({ ...base, value: draft.value });
      }
    }
    return result;
  });

/**
 * Resolve a binding's plaintext per-project var values into stored refs (for
 * secret vars) / plain strings, keyed by var name. Only the vars the binding
 * actually supplied are present; the var's `secret` flag decides storage.
 */
export const splitBindingVarValues = (input: {
  readonly projectId: ProjectId;
  readonly serverId: McpServerId;
  readonly vars: ReadonlyArray<McpServerVar>;
  readonly draftVarValues: Readonly<Record<string, string>>;
  /** Names whose existing stored value/ref must be preserved (client left the masked field blank). */
  readonly keepNames: ReadonlyArray<string>;
  /** The binding's existing var values, to source the preserved entries from. */
  readonly existing: Readonly<Record<string, McpVarValue>>;
}): Effect.Effect<Record<string, McpVarValue>, SecretStoreError, ServerSecretStore> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const secretVarNames = new Set(
      input.vars.filter((declared) => declared.secret).map((declared) => declared.name),
    );
    const result: Record<string, McpVarValue> = {};
    // Preserve untouched entries (masked secret left blank): carry the existing value/ref over.
    for (const name of input.keepNames) {
      const previous = input.existing[name];
      if (previous !== undefined) {
        result[name] = previous;
      }
    }
    for (const [name, value] of Object.entries(input.draftVarValues)) {
      if (secretVarNames.has(name)) {
        const secretName = mcpVarSecretName({
          serverId: input.serverId,
          varName: name,
          projectId: input.projectId,
        });
        yield* secretStore.set(secretName, textEncoder.encode(value));
        result[name] = { secretRef: secretName };
      } else {
        result[name] = value;
      }
    }
    return result;
  });

/** The effective var value for a name: binding override → catalog default → null. */
function effectiveVarValue(
  declared: McpServerVar,
  varValues: Readonly<Record<string, McpVarValue>>,
): McpVarValue | null {
  return declared.name in varValues ? varValues[declared.name]! : declared.value;
}

/** Every secret ref referenced by the effective var values (catalog + binding). */
export function collectVarSecretRefs(
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): ReadonlyArray<string> {
  const refs: string[] = [];
  for (const declared of vars) {
    const effective = effectiveVarValue(declared, varValues);
    if (effective !== null && isSecretRef(effective)) {
      refs.push(effective.secretRef);
    }
  }
  return refs;
}

/**
 * ru-fork #9: names of REQUIRED secret vars whose stored secret is ABSENT (deleted / never written).
 * Such a var resolves to "" and would launch a blank credential — the caller treats the instance as
 * incomplete (excluded from probe + overlay), exactly like a missing required value.
 */
export const missingSecretVarNames = (
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): Effect.Effect<ReadonlyArray<string>, SecretStoreError, ServerSecretStore> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const missing: string[] = [];
    for (const declared of vars) {
      if (!declared.required) {
        continue; // optional secret missing ⇒ "" is acceptable (matches missingRequiredVars semantics)
      }
      const effective = effectiveVarValue(declared, varValues);
      if (effective !== null && isSecretRef(effective)) {
        const bytes = yield* secretStore.get(effective.secretRef);
        if (bytes === null) {
          missing.push(declared.name);
        }
      }
    }
    return missing;
  });

/** Materialize every effective secret ref to plaintext (ref-name → value). */
export const materializeSecretValues = (
  vars: ReadonlyArray<McpServerVar>,
  varValues: Readonly<Record<string, McpVarValue>>,
): Effect.Effect<Record<string, string>, SecretStoreError, ServerSecretStore> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const resolved: Record<string, string> = {};
    for (const ref of collectVarSecretRefs(vars, varValues)) {
      const bytes = yield* secretStore.get(ref);
      resolved[ref] = bytes ? textDecoder.decode(bytes) : "";
    }
    return resolved;
  });
