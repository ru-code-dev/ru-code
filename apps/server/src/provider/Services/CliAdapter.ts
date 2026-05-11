/**
 * CliAdapter — shape type for the Cli provider adapter.
 *
 * Follows the same pattern as CursorAdapter: no Context.Service tag, only
 * a shape interface as a naming anchor for the driver bundle. The driver
 * model ({@link ../Drivers/CliDriver}) bundles one adapter per instance
 * as a captured closure.
 *
 * @module CliAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CliAdapterShape — per-instance Cli adapter contract.
 */
export interface CliAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
