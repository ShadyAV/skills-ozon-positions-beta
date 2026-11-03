// The sanitizing of an error the extension sends (refactor spec §7.5): a code of the safe shape, a bounded message, a
// known stage and a closed browser-job rejection; anything else falls back to the browser-job authorization failure.
import { parseBrowserJobRejection, rejectionGuidance } from '../../transport/failures/rejection.mjs';
import { SAFE_STAGES, ToolExecutionError } from '../../shared/coded-error.mjs';
import { MAX_SAFE_MESSAGE_LENGTH } from '../../transport/extension/wire.mjs';
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
// Parse boundary: `value` is an error object the extension sent, read field by field.
export const safeExternalToolError = (value, fallbackMessage = 'Browser job authorization failed.') => {
    const code = typeof value?.code === 'string' && SAFE_CODE.test(value.code) ? value.code : 'BROWSER_JOB_AUTHORIZATION_FAILED';
    const rejection = parseBrowserJobRejection(code, value?.browserJobRejection);
    const message = rejectionGuidance(rejection) ??
        (typeof value?.message === 'string' && value.message.length > 0 && value.message.length <= MAX_SAFE_MESSAGE_LENGTH
            ? value.message
            : fallbackMessage);
    const stage = SAFE_STAGES.has(value?.stage) ? value.stage : 'authorization';
    const error = new ToolExecutionError(code, message, stage, value?.retryable === true);
    if (rejection)
        error.details = Object.freeze({ browserJobRejection: rejection });
    return error;
};
