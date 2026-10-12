/**
 * Boot step: raises Node's connect attempt timeout before any other module
 * opens a socket. `src/index.ts` imports this file FIRST (a source test pins
 * that), so its side effect runs ahead of every other import. The logic and its
 * reasons live in network-defaults.ts; this file only calls it.
 */

import { applyNetworkDefaults } from './network-defaults.js';

export const NETWORK_DEFAULTS = applyNetworkDefaults();
