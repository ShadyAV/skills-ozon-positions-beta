import { safeFeedbackProperty } from '../../transport/failures/evidence.mjs';
// A short-lived Windows handle can deny removal or an owned temporary file's rename. Retry only
// errors that leave the requested operation undone; unknown failures must reach the caller.
// Each flow keeps its own codes, attempts and delay (spec §7.3); MCP store renames are not retried.
export const RETRY_POLICIES = Object.freeze({
    BROWSER_JOB: Object.freeze({ codes: Object.freeze(['EBUSY', 'EPERM']), attempts: 21, delayMs: 5 }),
    FEEDBACK: Object.freeze({ codes: Object.freeze(['EBUSY', 'EPERM']), attempts: 21, delayMs: 5 }),
    UPDATE: Object.freeze({ codes: Object.freeze(['EACCES', 'EBUSY', 'EPERM']), attempts: 10, delayMs: 10 }),
});
export const retryTransientFileOperation = async (operation, policy, wait = setTimeout) => {
    for (let attempt = 0;; attempt += 1) {
        try {
            return await operation();
        }
        catch (error) {
            if (attempt >= policy.attempts - 1 || !policy.codes.includes(safeFeedbackProperty(error, 'code')))
                throw error;
            await new Promise(resolveWait => wait(resolveWait, policy.delayMs));
        }
    }
};
