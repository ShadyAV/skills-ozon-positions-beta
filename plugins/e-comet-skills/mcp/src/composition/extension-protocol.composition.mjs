import { AUTHORIZATION_FETCH_ERROR_CODES, localMessage, MESSAGE_TYPES, RETRYABLE_FETCH_ERROR_CODES, SELLER_FAILURE_CLASSES, SELLER_FAILURE_REASONS, UNCLASSIFIED_FETCH_ERROR_CODE, WB_FETCH_TIMEOUT_PHASES, wbaasRecoveryOutcome, } from '../transport/extension/wire.mjs';
import { fetchFailureGuidance } from '../transport/failures/vocabulary.mjs';
import { safeOzonPromotionToolError } from '../ozon-seller/domain/converters/errors.converter.mjs';
import { createSessionMessages, parseServerMessage } from '../bridge/broker/messages.mjs';
import { safeExternalToolError } from '../bridge/broker/sanitize.mjs';
import { ToolExecutionError } from '../shared/coded-error.mjs';
import { isValidSellerStreamChunk, isValidSellerStreamEnd, isValidSellerStreamStart } from '../wb-seller/out/extension/validators.mjs';
import { OZON_OPERATION_TYPES, isValidOzonOperationPayload } from '../ozon-seller/out/extension/validators.mjs';
// Parse boundary: a payload as the extension sent it, checked by the family validators.
const isValidOperationPayload = (type, payload) => {
    if (!isValidOzonOperationPayload(type, payload))
        return false;
    if (type === MESSAGE_TYPES.wbFetchStreamStart) {
        if (!isValidSellerStreamStart(payload))
            return false;
    }
    if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
        if (!isValidSellerStreamChunk(payload))
            return false;
    }
    if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
        if (!isValidSellerStreamEnd(payload))
            return false;
    }
    return true;
};
export const parseExtensionServerMessage = (value) => parseServerMessage(value, { operationTypes: OZON_OPERATION_TYPES, isValidOperationPayload });
// The closed evidence a `wb_fetch_result` failure may carry beside its code (contract `wbFetchResultFields`).
// Parse boundary: the fetch response as the extension sent it, read field by field.
export const fetchFailureDetails = (code, response) => {
    const details = {};
    if (code === 'WB_FETCH_TIMEOUT' && WB_FETCH_TIMEOUT_PHASES.includes(response.phase))
        details.phase = response.phase;
    if (SELLER_FAILURE_REASONS[code]?.includes(response.reason))
        details.reason = response.reason;
    if (SELLER_FAILURE_CLASSES.includes(response.class) && typeof response.wbRefused === 'boolean') {
        Object.assign(details, { class: response.class, wbRefused: response.wbRefused });
        if (Number.isSafeInteger(response.httpStatus) && response.httpStatus >= 100 && response.httpStatus <= 599)
            details.httpStatus = response.httpStatus;
    }
    const recovery = wbaasRecoveryOutcome(response.wbaasRecovery);
    if (recovery)
        details.recovery = recovery;
    return Object.keys(details).length ? Object.freeze(details) : undefined;
};
/**
 * Runs today's extension session over a broker session (bridge/broker/messages.mjs) with the family frames: the WB fetch
 * results and seller streams, and the Ozon operations with their acknowledgements.
 */
export const createExtensionProtocol = ({ connections, requestBroker, log, broadcastStatus = () => undefined }) => {
    // A family operation's id when no session request owns it. Ownership decides the collection: `a() || b()` would
    // always touch the first and log a false late response for the others.
    const rejectOperation = (id, rejection) => requestBroker.hasPendingOzonPromotionOperation(id)
        ? requestBroker.rejectOzonPromotionReport(id, rejection)
        : requestBroker.hasPendingOzonReportPackage(id)
            ? requestBroker.rejectOzonReportPackage(id, rejection)
            : requestBroker.hasPendingSellerOperation(id)
                ? requestBroker.rejectSellerOperation(id, rejection)
                : requestBroker.rejectFetch(id, rejection);
    // Parse boundary: a frame the parser accepted, read by its type.
    const handleOperation = async (session, message) => {
        const { payload, type } = message;
        if (type === MESSAGE_TYPES.wbFetchStreamStart) {
            await requestBroker.startSellerStream(message.id, payload);
            return;
        }
        if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
            await requestBroker.appendSellerStreamChunk(message.id, payload.index, payload.data);
            return;
        }
        if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
            await requestBroker.endSellerStream(message.id, payload);
            return;
        }
        if (type === MESSAGE_TYPES.ozonReportPhase) {
            const handled = await requestBroker.recordOzonReportPackagePhase(message.id, payload.family, payload);
            if (handled)
                session.send(localMessage(message.id, payload.family === 'promotion' ? MESSAGE_TYPES.ozonPromotionStreamAck : MESSAGE_TYPES.ozonAnalyticsStreamAck, { frameId: payload.frameId }));
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamStart) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.startOzonReportPackageStream(message.id, 'promotion', payload)
                : await requestBroker.startOzonPromotionStream(message.id, payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamChunk) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.appendOzonReportPackageStreamChunk(message.id, 'promotion', payload)
                : await requestBroker.appendOzonPromotionStreamChunk(message.id, payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamEnd) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.endOzonReportPackageStream(message.id, 'promotion', payload)
                : await requestBroker.endOzonPromotionStream(message.id, payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionResult) {
            if (Object.hasOwn(payload, 'itemIndex')) {
                const { itemIndex, ...result } = payload;
                await requestBroker.resolveOzonReportPackageItem(message.id, 'promotion', itemIndex, result);
            }
            else if (requestBroker.hasPendingOzonReportPackage(message.id)) {
                requestBroker.rejectOzonReportPackage(message.id, new ToolExecutionError('ARTIFACT_REJECTED', 'The Ozon report package received a result without its item index.', 'artifact', false));
            }
            else if (payload.ok)
                requestBroker.resolveOzonPromotionReport(message.id, payload);
            else
                requestBroker.rejectOzonPromotionReport(message.id, safeOzonPromotionToolError(payload.error));
            return;
        }
        if (type === MESSAGE_TYPES.ozonAnalyticsStreamStart ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamChunk ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamEnd) {
            const handled = type === MESSAGE_TYPES.ozonAnalyticsStreamStart
                ? await requestBroker.startOzonReportPackageStream(message.id, 'analytics', payload)
                : type === MESSAGE_TYPES.ozonAnalyticsStreamChunk
                    ? await requestBroker.appendOzonReportPackageStreamChunk(message.id, 'analytics', payload)
                    : await requestBroker.endOzonReportPackageStream(message.id, 'analytics', payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonAnalyticsStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonAnalyticsResult || type === MESSAGE_TYPES.ozonSearchPositionsResult) {
            const { itemIndex, ...result } = payload;
            const family = type === MESSAGE_TYPES.ozonAnalyticsResult ? 'analytics' : 'positions';
            await requestBroker.resolveOzonReportPackageItem(message.id, family, itemIndex, result);
            return;
        }
        if (type !== MESSAGE_TYPES.wbFetchResult)
            return;
        if (typeof payload.response?.error === 'string') {
            const code = typeof payload.response.code === 'string' ? payload.response.code : UNCLASSIFIED_FETCH_ERROR_CODE;
            const authorizationFailure = AUTHORIZATION_FETCH_ERROR_CODES.includes(code);
            const retryable = RETRYABLE_FETCH_ERROR_CODES.includes(code);
            const details = fetchFailureDetails(code, payload.response);
            const rejection = safeExternalToolError({
                code,
                message: fetchFailureGuidance(code, details) ?? payload.response.error,
                stage: authorizationFailure ? 'authorization' : 'execution',
                retryable,
            }, 'Wildberries request failed.');
            if (details)
                rejection.details = details;
            if (requestBroker.hasPendingSellerOperation(message.id))
                requestBroker.rejectSellerOperation(message.id, rejection);
            else
                requestBroker.rejectFetch(message.id, rejection);
        }
        else if (requestBroker.hasPendingSellerOperation(message.id)) {
            requestBroker.resolveSellerOperation(message.id, payload.response);
        }
        else {
            requestBroker.resolveFetch(message.id, payload.response, { includeRequestId: true });
        }
    };
    return createSessionMessages({ connections, requestBroker, log, broadcastStatus, parseMessage: parseExtensionServerMessage, rejectOperation,
        handleOperation });
};
