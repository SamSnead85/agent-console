/** Public, dependency-free analysis API. Increment on incompatible changes. */
export const ANALYSIS_VERSION = 1;
export { contextHealth } from './context.js';
export { GUARD_POLICY_VERSION, parseGuardPolicy, evaluateGuard } from './guard.js';
