import { REQUEST_TIMEOUT_GRACE_MS } from '../../../bridge/limits.mjs';
import { ARTIFACT_MAX_FILE_BYTES } from '../../../storage/limits.mjs';
import { OZON_PROMOTION_OPERATION_MAX_MS } from '../../domain/constants/limits.const.mjs';
import { normalizeOzonPromotionError, ozonPromotionError } from '../../domain/converters/errors.converter.mjs';
import { isValidOzonPromotionOperation } from './validators.mjs';
// The correlation type of the Ozon promotion operation; its frames are delivered by the request broker under it.
export const OZON_PROMOTION = 'ozon_promotion';
const OZON_PROMOTION_OPERATION_MIN_MS = 1000;
const isValidOzonPromotionTimeout = (value) => Number.isSafeInteger(value) && value >= OZON_PROMOTION_OPERATION_MIN_MS && value <= OZON_PROMOTION_OPERATION_MAX_MS;
/**
 * The Ozon promotion state machine over the correlation broker (refactor spec §7.4): one operation per signed
 * authorization, checked against the lease's active scope, its authorization, the attested job type and the operation's
 * shape before it is sent through `route`; its workbook streams through the caller's handlers, in order, and the result
 * follows the stream's end. `reservation` is the one Ozon reservation it shares with the package state machine.
 */
export const createOzonPromotion = ({ correlation, route, reservation }) => {
    const consumed = new WeakSet();
    const reportUnsettled = (kind, requestId, detail) => correlation.reportUnsettled(kind, requestId, detail);
    // Every frame of the one Ozon promotion operation, by its id.
    const ozonPromotionFrame = (requestId, pending, { type, payload }) => {
        if (type === 'result')
            return resolveOzonPromotionReport(requestId, pending, payload);
        if (type === 'error')
            return rejectOzonPromotionReport(requestId, pending, payload);
        if (type === 'stream_start')
            return startOzonPromotionStream(requestId, pending, payload);
        if (type === 'stream_chunk')
            return appendOzonPromotionStreamChunk(requestId, pending, payload);
        return endOzonPromotionStream(requestId, pending, payload);
    };
    const resolveOzonPromotionReport = (requestId, pending, result) => {
        if (pending.state !== 'awaiting-result') {
            cancelOzonPromotionOperation(requestId, pending, ozonPromotionError('ARTIFACT_REJECTED', 'The Ozon promotion result arrived before the artifact stream ended.'));
            return false;
        }
        return settleOzonPromotionOperation(requestId, pending, (value) => pending.resolve(value), result);
    };
    const rejectOzonPromotionReport = (requestId, pending, error) => {
        cancelOzonPromotionOperation(requestId, pending, normalizeOzonPromotionError(error, 'OZON_AUTHORIZATION_REJECTED', 'The extension rejected the Ozon promotion operation.'));
        return true;
    };
    const startOzonPromotionStream = async (requestId, pending, metadata) => {
        if (pending.state !== 'awaiting-stream')
            return rejectInvalidOzonStream(requestId, pending);
        const { frameId: _frameId, ...handlerMetadata } = metadata;
        pending.state = 'streaming';
        pending.declaredStreamBytes = metadata.declaredSize ?? null;
        pending.maxStreamBytes = metadata.declaredSize ?? ARTIFACT_MAX_FILE_BYTES;
        return enqueueOzonHandler(requestId, pending, pending.streamHandlers.onStart, [handlerMetadata]);
    };
    const appendOzonPromotionStreamChunk = async (requestId, pending, chunk) => {
        if (pending.state !== 'streaming' || chunk.index !== pending.nextChunkIndex) {
            return rejectInvalidOzonStream(requestId, pending);
        }
        const decodedBytes = Buffer.byteLength(chunk.data, 'base64');
        if (pending.receivedStreamBytes + decodedBytes > pending.maxStreamBytes) {
            return rejectInvalidOzonStream(requestId, pending);
        }
        pending.nextChunkIndex += 1;
        pending.receivedStreamBytes += decodedBytes;
        return enqueueOzonHandler(requestId, pending, pending.streamHandlers.onChunk, [chunk.index, chunk.data]);
    };
    const endOzonPromotionStream = async (requestId, pending, metadata) => {
        if (pending.state !== 'streaming' ||
            metadata.size !== pending.receivedStreamBytes ||
            (pending.declaredStreamBytes !== null && metadata.size !== pending.declaredStreamBytes)) {
            return rejectInvalidOzonStream(requestId, pending);
        }
        pending.state = 'finalizing';
        const { frameId: _frameId, ...handlerMetadata } = metadata;
        return enqueueOzonHandler(requestId, pending, pending.streamHandlers.onEnd, [handlerMetadata], () => {
            pending.state = 'awaiting-result';
        });
    };
    // Parse boundary: the operation and its handlers as the job passed them, and the lease binding, each checked before use.
    const requestOzonPromotionReport = (operation, streamHandlers, timeout, authorizationId, authorizationScopeId) => {
        const authorizationScope = correlation.scopes.get(authorizationScopeId);
        if (!authorizationScope || !correlation.scopeIsActive(authorizationScopeId, authorizationScope)) {
            return Promise.reject(ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'The signed Ozon promotion authorization is no longer active.'));
        }
        if (authorizationScope.authorizationId !== authorizationId ||
            authorizationScope.jobType !== 'ozon_seller_promotion_report' ||
            !isValidOzonPromotionOperation(operation)) {
            return Promise.reject(ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'Only a matching signed Ozon promotion operation may use this authorization.'));
        }
        if (!streamHandlers ||
            typeof streamHandlers.onStart !== 'function' ||
            typeof streamHandlers.onChunk !== 'function' ||
            typeof streamHandlers.onEnd !== 'function') {
            return Promise.reject(ozonPromotionError('ARTIFACT_REJECTED', 'Ozon artifact storage is not ready to receive the report stream.'));
        }
        if (!isValidOzonPromotionTimeout(timeout)) {
            return Promise.reject(ozonPromotionError('OPERATION_DEADLINE_EXCEEDED', 'The Ozon promotion operation timeout must be between one second and eight minutes.'));
        }
        const deadlineRemaining = operation.deadlineAt - Date.now();
        if (deadlineRemaining <= 0 || deadlineRemaining > OZON_PROMOTION_OPERATION_MAX_MS) {
            return Promise.reject(ozonPromotionError('OPERATION_DEADLINE_EXCEEDED', deadlineRemaining <= 0
                ? 'The Ozon promotion operation deadline has expired.'
                : 'The Ozon promotion operation deadline exceeds the eight-minute lifecycle limit.'));
        }
        const boundedTimeout = Math.min(timeout, deadlineRemaining, OZON_PROMOTION_OPERATION_MAX_MS);
        if (reservation.current !== null) {
            return Promise.reject(ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'Another Ozon promotion operation is already pending.'));
        }
        if (typeof route !== 'function') {
            return Promise.reject(ozonPromotionError('OZON_ROUTE_NOT_READY', 'The Ozon promotion operation route is not available.'));
        }
        return correlation.open({
            type: OZON_PROMOTION,
            payload: {
                authorizationId,
                authorizationScopeId,
                dateFrom: operation.dateFrom,
                dateTo: operation.dateTo,
                deadlineAt: operation.deadlineAt,
                timeout: boundedTimeout,
            },
            timeoutMs: Math.min(deadlineRemaining, OZON_PROMOTION_OPERATION_MAX_MS, timeout + REQUEST_TIMEOUT_GRACE_MS),
            // The deadline's terminal passes the abort handler's normalization unchanged.
            timeoutError: () => ozonPromotionError('OPERATION_DEADLINE_EXCEEDED', 'The Ozon promotion operation deadline expired.'),
            authorization: { id: authorizationId, scopeId: authorizationScopeId },
            // The one Ozon reservation is taken before the operation is sent.
            createState: (control) => {
                const currentPending = {
                    resolve: control.resolve,
                    reject: control.reject,
                    state: 'awaiting-stream',
                    nextChunkIndex: 0,
                    receivedStreamBytes: 0,
                    declaredStreamBytes: null,
                    maxStreamBytes: ARTIFACT_MAX_FILE_BYTES,
                    streamHandlers,
                    handlerChain: Promise.resolve(),
                    cancelled: false,
                    abortController: new AbortController(),
                    authorizationScopeId,
                };
                reservation.current = { kind: 'promotion-single', pending: currentPending };
                return currentPending;
            },
            // A route is defined once it was checked above.
            via: (frame) => route({ requestId: frame.id, ...frame.payload }),
            onFrame: (frame, control) => ozonPromotionFrame(control.id, control.state, frame),
            onScopeEnded: (_error, _scope, control) => cancelOzonPromotionOperation(control.id, control.state, ozonPromotionError('OPERATION_CANCELLED', 'The Ozon promotion operation was cancelled with its authorization.')),
            onAbort: (errorOrMessage, control) => cancelOzonPromotionOperation(control.id, control.state, normalizeOzonPromotionError(errorOrMessage, 'OPERATION_CANCELLED', 'The Ozon promotion operation was cancelled because its extension route closed.')),
            onSendError: (error, control) => settleOzonPromotionOperation(control.id, control.state, (reason) => control.reject(reason), normalizeOzonPromotionError(error, 'OZON_ROUTE_NOT_READY', 'The Ozon promotion operation route is not available.'), { abort: true }),
        }).result;
    };
    const takeOzonPromotionOperation = (requestId, pending) => {
        if (correlation.stateOf(requestId) !== pending)
            return false;
        correlation.close(requestId);
        pending.cancelled = true;
        if (reservation.current?.pending === pending)
            reservation.current = null;
        return true;
    };
    const signalOzonCancellation = (requestId, pending, error) => {
        pending.abortController.abort(error);
        // A relay handler may itself be waiting for downstream persistence acknowledgement. Break that wait
        // synchronously; private handler/finalizer cleanup is observed separately and never owns broker capacity.
        if (typeof pending.streamHandlers.onCancel === 'function') {
            try {
                pending.streamHandlers.onCancel(error);
            }
            catch (cancelSignalError) {
                reportUnsettled('ozon-cancel-signal', requestId, cancelSignalError?.code);
            }
        }
    };
    const settleOzonPromotionOperation = (requestId, pending, settle, value, { abort = false } = {}) => {
        if (!takeOzonPromotionOperation(requestId, pending))
            return false;
        if (abort)
            signalOzonCancellation(requestId, pending, value);
        settle(value);
        return true;
    };
    const cancelOzonPromotionOperation = (requestId, pending, error) => {
        if (!takeOzonPromotionOperation(requestId, pending))
            return false;
        signalOzonCancellation(requestId, pending, error);
        pending.reject(error);
        return true;
    };
    const enqueueOzonHandler = (requestId, pending, handler, args, onComplete) => {
        const handlerPromise = pending.handlerChain.then(async () => {
            if (pending.cancelled || correlation.stateOf(requestId) !== pending)
                return false;
            await handler(...args, pending.abortController.signal);
            return !pending.cancelled && correlation.stateOf(requestId) === pending;
        });
        pending.handlerChain = handlerPromise;
        return handlerPromise.then((handled) => {
            if (handled)
                onComplete?.();
            return handled;
        }, (error) => {
            const settled = settleOzonPromotionOperation(requestId, pending, (reason) => pending.reject(reason), normalizeOzonPromotionError(error, 'ARTIFACT_REJECTED', 'The Ozon promotion artifact could not be stored safely.'), { abort: true });
            if (!settled)
                reportUnsettled('ozon-handler-error', requestId, error?.code);
            return false;
        });
    };
    const rejectInvalidOzonStream = (requestId, pending) => {
        cancelOzonPromotionOperation(requestId, pending, ozonPromotionError('ARTIFACT_REJECTED', 'Ozon promotion stream frames arrived out of order.'));
        return false;
    };
    // The one operation a signed promotion authorization allows, bound to its lease (spec §7.4 lease binding): the
    // lease's authorization id and scope.
    const run = (operation, streamHandlers, timeout, lease) => {
        if (consumed.has(lease)) {
            return Promise.reject(ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'This signed Ozon promotion authorization has already been used.'));
        }
        if (typeof lease === 'object' && lease !== null)
            consumed.add(lease);
        return requestOzonPromotionReport(operation, streamHandlers, timeout, lease?.id, lease?.scopeId);
    };
    return { run };
};
