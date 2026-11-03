import fs from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticCheck } from '../../../../transport/diagnostics/vocabulary.mjs';
const systemCause = (error) => ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? 'permission_denied' : 'io_error';
const step = (operation, state, systemCode, reason) => ({ operation, state, ...(systemCode ? { systemCode } : {}), ...(reason ? { reason } : {}) });
const probeStorageTarget = async (name, target, { observedAt, randomUUID, fileSystem }) => {
    const base = { check: 'storage_write', observedAt, source: 'safe_probe', executionPlane: 'device' };
    if (target?.state !== 'ready')
        return diagnosticCheck({ ...base, state: 'not_checked', cause: 'unknown', facts: { target: name, steps: [] } });
    try {
        if (!(await fileSystem.stat(target.path)).isDirectory())
            return diagnosticCheck({ ...base, state: 'not_checked', cause: 'directory_absent', facts: { target: name, steps: [] } });
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return diagnosticCheck({ ...base, state: 'not_checked', cause: 'directory_absent', facts: { target: name, steps: [] } });
        return diagnosticCheck({ ...base, state: 'failed', cause: systemCause(error), facts: { target: name, steps: [] } });
    }
    const path = join(target.path, `.e-comet-diagnostic-${randomUUID()}.tmp`);
    const payload = Buffer.from('e-comet-safe-probe\n');
    const steps = [];
    let handle;
    let failure;
    let acquired = false;
    let identity;
    try {
        try {
            handle = await fileSystem.open(path, 'wx');
            acquired = true;
            steps.push(step('create', 'passed'));
            // NTFS file IDs exceed 2^53, so only bigint stats tell neighbouring files apart.
            try {
                identity = await handle.stat({ bigint: true });
            }
            catch (error) {
                steps.push(step('identify', 'failed', error?.code));
                failure = error;
            }
        }
        catch (error) {
            steps.push(step('create', 'failed', error?.code));
            failure = error;
        }
        if (identity) {
            try {
                await handle.writeFile(payload);
                steps.push(step('write', 'passed'));
            }
            catch (error) {
                steps.push(step('write', 'failed', error?.code));
                failure = error;
            }
        }
        if (identity && !failure) {
            try {
                const read = await fileSystem.readFile(path);
                if (!read.equals(payload))
                    throw Object.assign(new Error('mismatch'), { code: 'EIO' });
                steps.push(step('read', 'passed'));
            }
            catch (error) {
                steps.push(step('read', 'failed', error?.code));
                failure = error;
            }
        }
    }
    finally {
        if (acquired) {
            let sameFile = false;
            if (identity) {
                try {
                    const current = await fileSystem.stat(path, { bigint: true });
                    sameFile = current.dev === identity.dev && current.ino === identity.ino;
                }
                catch (error) {
                    steps.push(step('remove', 'failed', error?.code));
                    failure ??= error;
                }
            }
            try {
                await handle.close();
            }
            catch (error) {
                steps.push(step('close', 'failed', error?.code));
                failure ??= error;
            }
            if (!identity) {
                // Accepted residual: the tiny probe file may remain because no existing store sweep owns its grammar.
                // See docs/local-agent-architecture.md#accepted-residuals.
                steps.push(step('remove', 'not_checked', undefined, 'identity_unavailable'));
            }
            else if (!sameFile && !steps.some(({ operation }) => operation === 'remove')) {
                const error = Object.assign(new Error('probe file identity changed'), { code: 'IDENTITY_CHANGED' });
                steps.push(step('remove', 'failed', error.code));
                failure ??= error;
            }
            else if (sameFile) {
                try {
                    await fileSystem.unlink(path);
                    steps.push(step('remove', 'passed'));
                }
                catch (error) {
                    steps.push(step('remove', 'failed', error?.code));
                    failure ??= error;
                }
            }
        }
    }
    return diagnosticCheck({ ...base, state: failure ? 'failed' : 'passed', ...(failure ? { cause: systemCause(failure) } : {}), facts: { target: name, steps } });
};
/** The installation storage_write probe over the real file system; tests inject a file system and an id source. */
export const createStorageProbe = ({ fileSystem = fs, randomUUID = () => globalThis.crypto.randomUUID() } = {}) => (name, target, { observedAt }) => probeStorageTarget(name, target, { observedAt, randomUUID, fileSystem });
