/** Public, dependency-free analysis API. Increment on incompatible changes. */
export const ANALYSIS_VERSION = 1;
export { contextHealth } from './context.js';
export { emptyAlertState, analyzeAlertEvent } from './alerts.js';
