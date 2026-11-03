import { copyReport } from '../../storage/delivery.mjs';
const SYSTEM_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'ENAMETOOLONG']);
const REASONS = new Set(['invalid_output_directory', 'invalid_artifact_metadata', 'source_not_file', 'integrity_mismatch']);
// Called after marketplace execution and before terminal publication/pin release.
// Failure preserves the completed report; it must never repeat a marketplace create.
export const deliverReportResult = async (result, artifacts, directory) => {
    if (directory === undefined || !artifacts.length)
        return result;
    const replacements = new Map();
    const failures = [];
    for (const [resourceIndex, artifact] of artifacts.entries()) {
        let stage = 'output_directory';
        try {
            replacements.set(artifact.uri, await copyReport(artifact, directory, value => { stage = value; }));
        }
        // A thrown value of any kind; only its message and code are read.
        catch (error) {
            failures.push({ resourceIndex, code: 'REPORT_DELIVERY_FAILED', stage,
                reason: REASONS.has(error?.message) ? error.message : (SYSTEM_CODES.has(error?.code) ? 'filesystem_error' : 'unexpected_error'),
                ...(SYSTEM_CODES.has(error?.code) ? { systemCode: error.code } : {}),
            });
        }
    }
    // Walks the result as JSON: any value may hold a link.
    const rewrite = (value) => {
        if (!value || typeof value !== 'object')
            return value;
        if (Array.isArray(value))
            return value.map(rewrite);
        const replacement = replacements.get(value.uri);
        const updated = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
        return replacement ? { ...updated, uri: replacement.uri, ...('path' in value ? { path: replacement.path } : {}) } : updated;
    };
    const fileDelivery = {
        status: failures.length ? (replacements.size ? 'partial' : 'failed') : 'complete',
        copied: replacements.size,
        failures,
    };
    return {
        ...result,
        content: [...rewrite(result.content), { type: 'text', text: failures.length
                    ? 'Report generation is preserved, but copying one or more files into the host project directory failed. Original resource links remain for those files. Do not regenerate reports or ask to mount internal plugin/session storage; diagnose local file delivery using fileDelivery.'
                    : 'Verified report copies are available in the host project e-comet-reports directory. Present the returned resource links.' }],
        structuredContent: { ...rewrite(result.structuredContent), fileDelivery },
        isError: result.isError || failures.length > 0,
    };
};
