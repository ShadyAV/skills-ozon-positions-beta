import { FEEDBACK_CLOUD_EXTENSION_LOG_MAX_BYTES } from './config.mjs';
import { isValidFeedbackDeviceSnapshot } from './feedback-device-diagnostics.mjs';
import { feedbackDiagnostics, safeFeedbackProperty } from './feedback-diagnostics.mjs';

// 3: the device projection carries client name and version, takeover and timing fields, and the
// preparation-time evidence checks. 4: it drops the takeover, listener and peer fields and carries the bridge cause
// code with its registration and broker facts instead. 5: the answer carries the extension's log for the archive, and
// the projection the extension_log check and the bridge block's owner, ComSpec, runtime re-check, unread policies,
// versions and transport events. An older cloud half fails closed until both halves are updated.
// Accepted residual "Mixed feedback halves refuse with a version mismatch": docs/local-agent-architecture.md#accepted-residuals.
export const FEEDBACK_HOST_ADAPTER_VERSION = 5;
// 2: the cloud hook uploads the archive itself and the marker carries nothing else. A device of either version
// answers it without an MCP error, so the cloud PostToolUse that uploads always runs.
export const FEEDBACK_CLOUD_TRANSPORT_VERSION = 2;

const UUID_V4_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const feedbackHostAdapterMarkerSchema = {
    type: 'object',
    properties: {
        version: { const: FEEDBACK_HOST_ADAPTER_VERSION },
        operationId: { type: 'string', pattern: UUID_V4_RE.source },
        nonce: { type: 'string', pattern: NONCE_RE.source },
    },
    required: ['version', 'operationId', 'nonce'],
    additionalProperties: false,
};

export const feedbackCloudTransportSchema = {
    type: 'object',
    properties: {
        version: { const: FEEDBACK_CLOUD_TRANSPORT_VERSION },
        operationId: { type: 'string', pattern: UUID_V4_RE.source },
        nonce: { type: 'string', pattern: NONCE_RE.source },
    },
    required: ['version', 'operationId', 'nonce'],
    additionalProperties: false,
};

export const hasFeedbackCloudTransport = (input) =>
    input !== null && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'feedbackCloud');

export const isValidFeedbackCloudSubmitInput = (input) => {
    if (!hasFeedbackCloudTransport(input) || Object.keys(input).some((key) => !['artifactId', 'feedbackCloud'].includes(key))) return false;
    const marker = input.feedbackCloud;
    if (!record(marker) || Object.keys(marker).length !== 3) return false;
    return marker.version === FEEDBACK_CLOUD_TRANSPORT_VERSION
        && typeof marker.operationId === 'string' && UUID_V4_RE.test(marker.operationId)
        && typeof marker.nonce === 'string' && NONCE_RE.test(marker.nonce);
};

// The device's whole part in a Cowork submit. The cloud PostToolUse uploads and replaces this answer, so the model
// sees it only when that hook reported nothing; a repeat is safe because the hook blocks one after an upload started.
// A cloud half older than this device passes the answer through, hence the step for that skew too: accepted
// residual, see docs/local-agent-architecture.md#accepted-residuals.
export const feedbackCloudSubmitPlaceholder = (args) => ({
    ok: false,
    status: 'failed',
    ...(typeof safeFeedbackProperty(args, 'artifactId') === 'string' && ARTIFACT_ID_RE.test(args.artifactId) ? { artifactId: args.artifactId } : {}),
    error: {
        code: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE',
        message: 'This device does not upload Cowork reports: the cloud e-Comet hook uploads the archive and replaces this result, so seeing it means the hook reported no outcome. Submit the same artifactId once more; the hook blocks a repeat if an upload already started. If this answer repeats, start a new task so the cloud session loads the current e-Comet plugin.',
        stage: 'handoff',
        retryable: false,
        details: feedbackDiagnostics(undefined, 'handoff_submit'),
    },
});

const INPUT_KEYS = {
    prepare_e_comet_feedback: new Set(['kind', 'summary', 'details', 'includeTranscript', 'feedbackAdapter']),
};

export const hasFeedbackHostAdapterMarker = (input) =>
    input !== null && typeof input === 'object' && Object.hasOwn(input, 'feedbackAdapter');

export const isValidFeedbackHostAdapterInput = (targetTool, input) => {
    const allowed = INPUT_KEYS[targetTool];
    const marker = input?.feedbackAdapter;
    if (!allowed || input === null || typeof input !== 'object' || Array.isArray(input)) return false;
    if (Object.keys(input).some((key) => !allowed.has(key))) return false;
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    if (Object.keys(marker).length !== 3 || !['version', 'operationId', 'nonce'].every((key) => Object.hasOwn(marker, key))) return false;
    return marker.version === FEEDBACK_HOST_ADAPTER_VERSION
        && typeof marker.operationId === 'string'
        && typeof marker.nonce === 'string'
        && UUID_V4_RE.test(marker.operationId)
        && NONCE_RE.test(marker.nonce);
};

// The cloud prepare handshake compares the complete placeholder, including prose. Treat edits as
// protocol changes and coordinate the adapter version; these strings are not independently editable UI copy.
const messages = {
    prepare_e_comet_feedback: 'The host feedback preparation result is unavailable. Do not authorize or submit feedback from this result.',
};

// `extensionLogText` is the device's extension-log.json for the cloud archive, already redacted and cut. The cloud
// PostToolUse replaces this answer; see the accepted residual "Cowork carries a trimmed extension log".
export const feedbackHostResultUnavailable = (targetTool, marker, bridgeStatus, extensionLogText = undefined) => ({
    ok: false,
    status: 'host_result_unavailable',
    adapter: {
        version: marker.version,
        operationId: marker.operationId,
        nonce: marker.nonce,
        targetTool,
    },
    bridgeStatus,
    ...(extensionLogText === undefined ? {} : { extensionLog: extensionLogText }),
    error: {
        code: 'FEEDBACK_HOST_RESULT_UNAVAILABLE',
        message: messages[targetTool],
        stage: 'handoff',
        retryable: false,
    },
});

// The log enters the archive as it came, so only a bounded JSON array is accepted.
const isExtensionLogText = (value) => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > FEEDBACK_CLOUD_EXTENSION_LOG_MAX_BYTES) return false;
    try { return Array.isArray(JSON.parse(value)); } catch { return false; }
};

export const isValidFeedbackHostAdapterResult = (targetTool, marker, value) => {
    if (!messages[targetTool] || !record(marker) || marker.version !== FEEDBACK_HOST_ADAPTER_VERSION) return false;
    if (!record(value) || value.ok !== false || value.status !== 'host_result_unavailable') return false;
    if (Object.keys(value).length !== (Object.hasOwn(value, 'extensionLog') ? 6 : 5) || (Object.hasOwn(value, 'extensionLog') && !isExtensionLogText(value.extensionLog))) return false;
    if (!record(value.adapter) || Object.keys(value.adapter).length !== 4 || value.adapter.version !== FEEDBACK_HOST_ADAPTER_VERSION
        || value.adapter.operationId !== marker.operationId || value.adapter.nonce !== marker.nonce || value.adapter.targetTool !== targetTool) return false;
    if (!isValidFeedbackDeviceSnapshot(value.bridgeStatus)) return false;
    if (!record(value.error) || Object.keys(value.error).length !== 4) return false;
    return value.error.code === 'FEEDBACK_HOST_RESULT_UNAVAILABLE' && value.error.message === messages[targetTool]
        && value.error.stage === 'handoff' && value.error.retryable === false;
};
