import { textResult, toolFailure } from '../../../../mcp-protocol/results/serialize.mjs';
import { invalidArgumentsMessage, validateArguments } from '../../../../mcp-protocol/registry/validate.mjs';
import { ToolExecutionError } from '../../../../shared/coded-error.mjs';
import { contract } from '../../contract/diagnose.contract.mjs';
import { collectDiagnosis } from '../../application/diagnose.mjs';
// e_comet_diagnose. `diagnosis(extensionInstall)` supplies what the diagnosis reads: the session, the bridge and the
// probes the root wired, with the profile probe answered by the refreshed facts when the refresh returned them.
export const createDiagnoseTool = ({ answer, refreshBridgeFacts, diagnosis }) => ({
    needsBridge: false,
    // Parse boundary: the client's arguments, validated against the contract first.
    run: async (id, args) => {
        const validation = validateArguments(contract.inputSchema, args);
        const invalid = !validation.ok ? validation
            : args.scope === 'last_operation' && (typeof args.operationHandle !== 'string' || !args.operationHandle)
                ? { property: 'operationHandle' } : undefined;
        if (invalid) {
            answer(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage('e_comet_diagnose', invalid), 'arguments', false)), true));
            return;
        }
        // A diagnosis must never fail because a refresh did.
        // Profile reads obey the same explicit probe contract as the collector; passive diagnoses keep stored facts.
        // A runtime extension_log probe reads the profiles too: status judges the fresh log against the profile
        // probe, which macOS never reads at start or in the background and elsewhere can be 30 s old.
        const withProbe = args.mode === 'safe_probes'
            && ((args.scope === 'installation' && args.probes?.includes('extension_install') === true)
                || (args.scope === 'runtime' && args.probes?.includes('extension_log') === true));
        const extensionInstall = await Promise.resolve().then(() => refreshBridgeFacts({ withProbe })).catch(() => undefined);
        answer(id, textResult(await collectDiagnosis({ ...args, ...diagnosis(extensionInstall) })));
    },
});
