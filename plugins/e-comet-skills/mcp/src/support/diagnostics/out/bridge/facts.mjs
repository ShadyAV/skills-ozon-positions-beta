import { collectExtensionLog, extensionLogCheck } from '../../../../bridge/profile/extension-log.mjs';
/**
 * The runtime extension_log probe: the extension's own log from the browser profile, read fresh, and its closed check.
 * A reader that throws is unreadable.
 */
export const createExtensionLogReader = (collect = collectExtensionLog) => async ({ now, observedAt }) => {
    const evidence = await collect({ now }).catch((error) => ({ state: 'unreadable', systemCode: error?.code, startFailureAtMs: [] }));
    return { evidence, check: extensionLogCheck(evidence, { observedAt, nowMs: Date.parse(observedAt) }) };
};
