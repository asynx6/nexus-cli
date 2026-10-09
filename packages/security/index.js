// @asynx6/security — PermissionManager (deny-by-default) + audit events + secret isolation
// public facade: export ONLY contracts here (see docs/ARCHITECTURE.md rule 4)
export const NAME = '@asynx6/nexus-security';
export { PermissionManager } from './src/permissions.js';
export { AuditTrail, redact } from './src/audit.js';
export { SecretStore } from './src/secrets.js';
export { Vault } from './src/vault.js';
export { ProjectSecrets } from './src/project-secrets.js';
export { TokenBucket, SlidingWindow, RateLimitError } from './src/rate-limit.js';
export {
  PERMISSION_MODES, isHardDeniedCommand, isHardDeniedPath,
  isWriteAction, isReadTool, loadSettings, saveSettings, evalRules,
} from './src/denylist.js';
