// @nexus/sandbox-runtime — public facade: contracts only (ARCHITECTURE.md rule 4).
export const NAME = '@nexus/sandbox-runtime';
export { DockerRuntime, LABEL_MANAGED_BY, LABEL_MANAGED_VALUE } from './lib/docker.js';
export { SocketHttpError, demuxExecStream } from './lib/sockhttp.js';
export { PolicyEngine, PolicyDeniedError, DEFAULT_POLICY, evaluate } from './src/policy.js';
export { HostRuntime, hostPath } from './src/host.js';
