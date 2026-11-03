import { ToolExecutionError } from '../../shared/coded-error.mjs';
const BROWSER_JOB_REJECTION_CODES = new Set(['BROWSER_JOB_REJECTED', 'BROWSER_JOB_ACCOUNT_MISMATCH']);
export const BROWSER_JOB_REJECTION_REASONS = new Set(['public_key_not_configured', 'user_not_available', 'invalid_format', 'invalid_algorithm', 'invalid_signature', 'issuer_mismatch', 'audience_mismatch', 'subject_mismatch', 'expired', 'invalid_job', 'token_reuse', 'ecomet_not_authenticated', 'activation_storage_unavailable', 'device_clock_ahead', 'device_clock_behind', 'storage_unavailable', 'unknown']);
export const BROWSER_JOB_INVALID_JOB_DIAGNOSTICS = new Set(['job_type', 'jobs_count', 'descriptor_type', 'descriptor_shape', 'date_from', 'date_to_or_range', 'claims_iat_or_jti']);
export const DEVICE_CLOCK_REASONS = Object.freeze(['device_clock_ahead', 'device_clock_behind']);
const exactKeys = (value, allowed, required) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
// Parse boundary: `value` comes from the extension and is narrowed here.
export const parseBrowserJobRejection = (code, value) => {
    if (!BROWSER_JOB_REJECTION_CODES.has(code) || !exactKeys(value, ['schemaVersion', 'reason', 'diagnostic', 'skewMinutes'], ['schemaVersion', 'reason']) ||
        value.schemaVersion !== 1 || !BROWSER_JOB_REJECTION_REASONS.has(value.reason))
        return undefined;
    if (value.diagnostic !== undefined && (value.reason !== 'invalid_job' || !BROWSER_JOB_INVALID_JOB_DIAGNOSTICS.has(value.diagnostic)))
        return undefined;
    if (value.skewMinutes !== undefined && (!DEVICE_CLOCK_REASONS.includes(value.reason) || !Number.isSafeInteger(value.skewMinutes) ||
        value.skewMinutes < 0 || value.skewMinutes > 1_000_000))
        return undefined;
    return Object.freeze({ schemaVersion: 1, reason: value.reason, ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
        ...(value.skewMinutes === undefined ? {} : { skewMinutes: value.skewMinutes }) });
};
// The agent's next step and its owner for a refusal reason the extension names (spec 7.2). A reason without a row
// keeps the extension's own message.
const AUTHORIZE_AGAIN = 'then request a new browser job.';
export const rejectionGuidance = (rejection) => {
    const skew = rejection?.skewMinutes === undefined ? '' : ` by about ${rejection.skewMinutes} minutes`;
    if (rejection?.reason === 'device_clock_ahead')
        return `This computer's clock runs ahead${skew}, so the extension saw the browser job as expired. ` +
            `Ask the user to sync the system clock, ${AUTHORIZE_AGAIN}`;
    if (rejection?.reason === 'device_clock_behind')
        return `This computer's clock runs behind${skew}, so the browser job looked issued in the future. ` +
            `Ask the user to sync the system clock, ${AUTHORIZE_AGAIN}`;
    if (rejection?.reason === 'storage_unavailable')
        return 'The browser could not read or write the extension storage. ' +
            `Ask the user to restart the browser, ${AUTHORIZE_AGAIN} If it repeats, offer to report it.`;
    return undefined;
};
export const browserJobRejectionDetails = (error) => error instanceof ToolExecutionError && error.details?.browserJobRejection
    // Only this process sets the field, and only with a parsed rejection.
    ? { browserJobRejection: error.details.browserJobRejection } : undefined;
