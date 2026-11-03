import { collectStaticFacts, diagnosticCheck, MCP_CONFIGURATION_FACTS } from '../../../transport/diagnostics/vocabulary.mjs';
const metadataCheck = (check, observation, observedAt, facts) => diagnosticCheck({
    check, state: observation.state, observedAt, source: 'package_metadata', executionPlane: 'device',
    ...(observation.cause ? { cause: observation.cause } : {}), ...(facts ? { facts } : {}),
});
const VERSION = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const safeVersion = (value) => typeof value === 'string' && value.length <= 128 && VERSION.test(value) ? value : undefined;
const validateMcpConfiguration = (observation) => {
    if (observation.state !== 'passed')
        return observation;
    const local = observation.value?.mcpServers?.['e-comet-local'];
    return local?.type === MCP_CONFIGURATION_FACTS.transport && local.command === MCP_CONFIGURATION_FACTS.command && Array.isArray(local.args)
        && local.args.length === 1 && local.args[0] === MCP_CONFIGURATION_FACTS.entrypoint && local.cwd === MCP_CONFIGURATION_FACTS.cwd
        ? { state: 'passed', value: local } : { state: 'failed', cause: 'corrupt' };
};
/**
 * The installation checks of one plugin, read through `installation`; the storage layout, OS release and clock values come
 * from the root.
 */
export const doctorReport = async ({ installation, storageLayout, osRelease, platform, arch, nodeVersion, observedAt }) => {
    const packageObservation = await installation.readPackage();
    const checks = collectStaticFacts({ platform, arch,
        // An unsafe package version is left out, as the facts allow.
        versions: { node: nodeVersion, bridge: safeVersion(packageObservation.value?.version), os: osRelease },
        storageLayout, observedAt });
    checks.push(diagnosticCheck({ check: 'package_layout', state: 'passed', observedAt, source: 'module_location',
        executionPlane: 'device', facts: { layout: 'installed_plugin' } }));
    const codexObservation = await installation.readCodexManifest();
    const validCodex = codexObservation.state === 'passed' && codexObservation.value?.name === 'e-comet-skills'
        && safeVersion(codexObservation.value?.version) && codexObservation.value?.mcpServers === './.mcp.json';
    checks.push(metadataCheck('codex_manifest', validCodex ? codexObservation : { state: 'failed', cause: codexObservation.cause ?? 'corrupt' }, observedAt, validCodex ? { name: 'e-comet-skills', version: codexObservation.value.version } : undefined));
    const mcpObservation = validateMcpConfiguration(await installation.readMcpConfiguration());
    checks.push(metadataCheck('mcp_configuration', mcpObservation, observedAt, mcpObservation.state === 'passed' ? MCP_CONFIGURATION_FACTS : undefined));
    checks.push(await installation.checkEntrypoint(mcpObservation.state === 'passed' ? mcpObservation.value : undefined, observedAt));
    return Object.freeze({ schemaVersion: 1, checks, limitations: Object.freeze({
            hostInstallation: 'not_checked', hostEnablement: 'not_checked', hookTrust: 'not_checked', otherExecutionPlanes: 'not_checked',
        }) });
};
