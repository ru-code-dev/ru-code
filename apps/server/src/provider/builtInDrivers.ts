/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with. This build is single-vendor: only one CLI provider.
 *
 * @module provider/builtInDrivers
 */
import { CliDriver, type CliDriverEnv } from "./Drivers/CliDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

export type BuiltInDriversEnv = CliDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [CliDriver];
