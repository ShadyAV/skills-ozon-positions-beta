import { createJobWriter } from '../../../storage/writers/results.mjs';
import { StorageUnavailableError } from '../../../shared/storage-unavailable.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { safeFeedbackProperty } from '../../../transport/failures/evidence.mjs';
import { LOCAL_STORAGE_MESSAGES } from '../../../transport/failures/vocabulary.mjs';
const storageCreationEvidence = new WeakMap();
const resultCreationFailure = (cause) => {
    const messages = LOCAL_STORAGE_MESSAGES;
    const code = safeFeedbackProperty(cause, 'code');
    const known = typeof code === 'string' && Object.hasOwn(messages, code);
    const error = new ToolExecutionError('LOCAL_STORAGE_FAILED', known ? messages[code] : 'The local result file could not be created.', 'storage', true, { cause });
    if (known)
        storageCreationEvidence.set(error, { operation: 'create_result', systemCode: code });
    return error;
};
/**
 * A job's NDJSON result file over storage/writers/results. A file that cannot be created is LOCAL_STORAGE_FAILED, whose
 * filesystem code `creationEvidence` names; an unavailable storage root stays its own error.
 */
export const createResults = ({ createJobWriter: createWriter = createJobWriter } = {}) => ({
    create: async (jobId) => {
        try {
            return await createWriter(jobId);
        }
        catch (error) {
            if (error instanceof StorageUnavailableError)
                throw error;
            throw resultCreationFailure(error);
        }
    },
    creationEvidence: (error) => storageCreationEvidence.get(error),
});
