import { isOsRelease } from './facts.mjs';
export const DIAGNOSTIC_STATES = Object.freeze(['passed', 'failed', 'unknown', 'not_checked', 'unsupported']);
export const MCP_CONFIGURATION_FACTS = Object.freeze({ transport: 'stdio', command: 'node', cwd: '.', entrypoint: 'mcp/src/server.mjs' });
export const DIAGNOSTIC_CAUSES = Object.freeze(['permission_denied', 'missing', 'directory_absent', 'corrupt', 'unsupported', 'io_error', 'unavailable', 'unknown']);
export const diagnosticCheck = (input) => {
    const { check, state, observedAt, source, executionPlane, facts, cause, evidenceRefs, nextCheck } = input;
    if (!DIAGNOSTIC_STATES.includes(state))
        throw new TypeError(`Unrecognized diagnostic state: ${state}`);
    if (cause !== undefined && !DIAGNOSTIC_CAUSES.includes(cause))
        throw new TypeError(`Unrecognized diagnostic cause: ${cause}`);
    return Object.freeze({ check, state, observedAt, source, executionPlane,
        ...(facts === undefined ? {} : { facts: Object.freeze(facts) }),
        ...(cause === undefined ? {} : { cause }),
        ...(evidenceRefs === undefined ? {} : { evidenceRefs: Object.freeze([...evidenceRefs]) }),
        ...(nextCheck === undefined ? {} : { nextCheck }),
    });
};
export const collectStaticFacts = (input) => {
    const { platform, arch, versions = {}, storageLayout = {}, observedAt = new Date().toISOString() } = input;
    return [
        diagnosticCheck({ check: 'runtime', state: 'passed', observedAt, source: 'node_process', executionPlane: 'device', facts: {
                nodeVersion: versions.node, platform, arch, ...(versions.bridge ? { bridgeVersion: versions.bridge } : {}),
                ...(versions.mcp ? { mcpProtocolVersion: versions.mcp } : {}),
                ...(isOsRelease(versions.os) ? { osRelease: versions.os } : {}),
            } }),
        diagnosticCheck({ check: 'storage', state: 'passed', observedAt, source: 'resolved_configuration', executionPlane: 'device', facts: {
                scope: 'configuration', targets: Object.fromEntries(Object.entries(storageLayout).map(([name, target]) => [name,
                    target?.state === 'ready' ? { state: 'ready', backend: target.backend } : { state: 'unavailable', reason: target?.reason ?? 'invalid_path' }
                ])),
            } }),
    ];
};
