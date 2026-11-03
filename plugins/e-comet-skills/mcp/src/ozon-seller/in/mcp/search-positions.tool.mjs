import { textResult } from '../../../mcp-protocol/results/serialize.mjs';
import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { executeOzonSearchPositionsJob, rejectedOzonSearchPositions } from '../../application/search-positions.mjs';
import { contract } from '../../contract/search-positions.contract.mjs';
import { isOzonPackageCapabilityFailure } from '../../domain/converters/errors.converter.mjs';
import { canonicalSearchPositionsRequest } from '../../domain/policies/search-positions.policy.mjs';
import { releaseAuthorizationInBackground } from './authorize.mjs';
/**
 * ozon_search_positions: the package path without artifact storage, since the table is small enough to return inline.
 */
export const createSearchPositionsTool = ({ answer, authorize, ozonPackage, withDownloadedUpdate, now, foreignJobs }) => ({
    needsBridge: true,
    // Parse boundary: the call's arguments, checked against the contract first.
    run: async (id, args = {}) => {
        const toolName = 'ozon_search_positions';
        let request;
        let result;
        try {
            const validation = validateArguments(contract.inputSchema, args);
            if (!validation.ok)
                throw new TypeError(invalidArgumentsMessage(toolName, validation));
            const { queries, skus, region, platform } = args;
            request = canonicalSearchPositionsRequest({ queries, skus, region, platform });
        }
        catch (error) {
            // Domain messages name the broken rule, never the rejected values.
            result = { ok: false, status: 'failed', jobType: toolName,
                error: { code: 'PREFLIGHT_FAILED', message: error.message, stage: 'preflight', retryable: false }, stopReason: null };
        }
        if (request) {
            let authorizationLease;
            try {
                authorizationLease = await authorize.authorizeOzonPackage('positions', args.triggerUrl);
                const lease = authorizationLease;
                result = await executeOzonSearchPositionsJob({
                    authorization: authorizationLease.authorization,
                    request,
                    requestOzonReportPackage: (packageRequest, handlers) => ozonPackage.run(packageRequest, handlers, lease),
                    now,
                    foreignJobs,
                });
            }
            catch (error) {
                result = rejectedOzonSearchPositions(request, await withDownloadedUpdate(error, isOzonPackageCapabilityFailure(error)));
            }
            finally {
                releaseAuthorizationInBackground(authorizationLease, 'after Ozon search positions completion');
            }
        }
        // A call either failed its preflight or ran (or was refused) with its canonical request.
        answer(id, textResult(result, !result.ok));
    },
});
