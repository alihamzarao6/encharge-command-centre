/**
 * The build-time environment, read once. Kept apart from config.ts so the resolver is unit
 * tested under Node, where `import.meta.env` does not exist.
 */
import { resolveWebConfig, type WebConfig } from './config.js';

export const webConfig: WebConfig = resolveWebConfig(import.meta.env);
