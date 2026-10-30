import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import { MAX_MCP_MESSAGE_BYTES } from '../mcp/src/config.mjs';
import { prepareECometFeedback, submitECometFeedback } from '../mcp/src/feedback-tools.mjs';
import { registerFeedbackArtifact, loadVerifiedFeedbackArtifact, retireFeedbackArtifact } from '../mcp/src/feedback-artifact-store.mjs';
import { feedbackPreparationFailure } from '../mcp/src/feedback-errors.mjs';
import { feedbackDiagnostics } from '../mcp/src/feedback-diagnostics.mjs';
import { putFeedbackArchive } from '../mcp/src/feedback-upload.mjs';
import { FEEDBACK_CLOUD_TRANSPORT_VERSION, isValidFeedbackHostAdapterResult, isValidFeedbackHostAdapterInput, isValidFeedbackCloudSubmitInput } from '../mcp/src/feedback-host-adapter.mjs';
import { FEEDBACK_MESSAGE_MAX_LENGTH, toolInputSchemas, toolOutputSchemas, validateSchemaValue } from '../mcp/src/tool-schemas.mjs';
import { claimUploadGrant, discardUploadGrant, stagePreparedArtifact, prepareInputWithTrustedTranscript, fitPrepareWireInput,
    cloudPostToolOutput as postOutput } from './feedback-handoff.mjs';
import { CloudFeedbackStore, cloudPaths, canRetryUploadOutcome } from './feedback-cloud-state.mjs';

const PREFIX = 'mcp__remote-devices__plugin_e-comet-skills_e-comet-local__';
// claimUploadGrant returns exactly these six transport fields; artifactId stays the authored one.
const TRANSPORT_KEYS = ['uploadUrl', 'requiredHeaders', 'objectKey', 'expiresAt', 'expectedSize', 'expectedSha256'];
// An upload that ended releases the authorization it used; nothing else may reuse one.
const TERMINAL_UPLOAD_STATUSES = ['uploaded', 'rejected', 'uncertain'];
// The report never crosses the bridge: the device only collects its own evidence for a cloud prepare, so it
// receives this fixed text in the two required fields. Only that exact input, or the authored one a host may
// report instead, binds the operation.
const DEVICE_REPORT_TEXT = 'Prepared by the cloud e-Comet hook; the device adds only its own diagnostics.';
const deviceInput = (authored, marker) => ({ kind: authored.kind, summary: DEVICE_REPORT_TEXT, details: DEVICE_REPORT_TEXT,
    includeTranscript: authored.includeTranscript, feedbackAdapter: marker });
// 412 is a success only under the grant that gives it that meaning: `If-None-Match: *` makes the PUT a
// create, so a precondition failure says the archive this call would have written is already stored.
const CREATE_ACCEPTED_STATUSES = [200, 201, 204, 412];
const forbidsOverwrite = headers =>
    Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'if-none-match' && value === '*');
const invalid = () => Object.assign(new Error('The trusted cloud feedback operation could not be verified.'), { feedbackReason: 'invalid_state' });
const parseHostJson = value => {
    try { return JSON.parse(value); }
    catch (error) { throw Object.assign(invalid(), { cause: error }); }
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);
// JSON object member order is transport formatting, not part of the trusted value.
const equal = isDeepStrictEqual;
const blocksUpload = outcome => outcome && !canRetryUploadOutcome(outcome.result);
// Every refusal before the upload request sent nothing and keeps the grant, because the claim reads it without
// consuming it: the same prepared artifact is simply submitted again. The service issues only a few
// authorizations per hour, and one more report_issue is the step only when the hook itself reports the grant
// expired or missing.
const GRANT_KEPT_STEP = 'Nothing was sent. The authorization is kept for this artifact: submit the same artifactId again, preserving the existing history choice; this hook says when a new authorization is needed.';
const keptGrant = result => {
    const appended = `${result.error.message} ${GRANT_KEPT_STEP}`;
    return { ...result, error: { ...result.error, message: appended.length <= FEEDBACK_MESSAGE_MAX_LENGTH ? appended : GRANT_KEPT_STEP } };
};
// WHY: a request that failed before its TLS session opened carried no byte of the archive. From the Cowork sandbox
// that is the account's or organization's network egress setting as a rule, so it is a no-send refusal that keeps
// the authorization and names that setting, not an uncertain upload. Reports need that setting: accepted residual
// "Cowork reports need All domains", see docs/local-agent-architecture.md#accepted-residuals.
const EGRESS_STEP = 'e-Comet storage could not be reached from this cloud session, and nothing was sent. Ask the user to set Settings → Capabilities → Allow network egress to All domains (in an organization the admin controls it), then submit the same artifactId again, preserving the existing history choice; the authorization is kept. If storage stays unreachable, start a new task and report from there.';
const egressRefusal = (error, artifactId) => ({ ok: false, status: 'not_started', artifactId, error: {
    code: 'FEEDBACK_SUBMISSION_FAILED', message: EGRESS_STEP, stage: 'handoff', retryable: false, details: feedbackDiagnostics(error, 'upload') } });
const hook = value => ({ exitCode: 0, stdout: json({ hookSpecificOutput: value }), stderr: '' });
const prepareRefusalOutput = eventName => {
    const result = feedbackPreparationFailure({ code: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' });
    result.error.message = 'The device did not complete the cloud preparation handoff. This call prepared no report; do not call report_issue. Check the device tool error and the e-Comet plugin versions in this cloud session and on the device. If they differ, update the older installation and start a new cloud task before preparing again with the same consent and history choice. A version mismatch is not established by this refusal alone.';
    // Failure has no structured tool response to replace. Its opaque error is not parsed or echoed;
    // only prepare is safe to explain here, because archive creation runs after the device handshake.
    return eventName === 'PostToolUseFailure'
        ? hook({ hookEventName: eventName, additionalContext: json(result) }) : postOutput(result);
};
const recoveryOutput = result => hook({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    'This repeat call was blocked. The saved host outcome below is read-only recovery; no new upload was started. Do not request another grant or send this artifact again. ' + json(result) });
const notStartedOutput = result => hook({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    'This call did not start upload. ' + json(result) });
// A refusal after the claim is not just a failure to report: the session holds a prepared artifact and
// a grant this call did not spend. Each branch names the one step that restores the flow, because
// nothing left in the session says which it is.
const keptGrantMessage = cause => `${cause} Nothing was sent and this call did not start upload. The authorization is untouched and still staged for this artifact: submit the same artifactId again, preserving the existing history choice, and request no new authorization.`;
const UNRECORDED_KEPT_MESSAGE = keptGrantMessage('The cloud upload could not be recorded.');
const ARCHIVE_KEPT_MESSAGE = `${keptGrantMessage('The prepared feedback archive could not be read.')} If it still cannot be read, prepare the report again.`;
const safeFailure = (error, artifactId, status = 'uncertain', code = 'FEEDBACK_SUBMISSION_FAILED', authored = undefined) => ({
    ok: false, status, ...(artifactId ? { artifactId } : {}), error: { code,
        message: authored ?? (code === 'FEEDBACK_GRANT_MISSING'
            ? 'No upload grant is staged for this artifact. This call did not start upload. If report_issue has not been called for the prepared artifact, call it once with the prepared kind and size_bytes. If it already returned, inspect that result and handoff evidence before repeating it.'
            : code === 'FEEDBACK_GRANT_REFRESH_REQUIRED'
                ? 'The upload grant cannot cover the required start window. This call did not start upload. Call report_issue again for the same prepared artifact, preserving the existing history choice.'
                : status === 'not_started'
                    ? error?.code === 'FEEDBACK_ARTIFACT_MISMATCH'
                        ? 'The staged grant belongs to a different prepared artifact. This call did not start upload. Inspect the latest prepared result and authorization before continuing.'
                        : 'This call did not start upload. Inspect the handoff diagnostics and existing authorization before continuing.'
                    : 'The trusted cloud feedback operation could not complete. Inspect the saved same-artifact outcome before any further action.'),
        stage: status === 'not_started' ? 'handoff' : 'submit',
        retryable: false, details: feedbackDiagnostics(error, 'handoff_submit') },
});
const trustedField = (event, snake, camel, max = 512) => {
    const value = event[snake] ?? event[camel];
    if (event[snake] !== undefined && event[camel] !== undefined && !equal(event[snake], event[camel])) throw invalid();
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max) throw invalid();
    return value;
};
const hostValue = (event, snake, camel) => {
    if (event[snake] !== undefined && event[camel] !== undefined && !equal(event[snake], event[camel])) throw invalid();
    return event[snake] ?? event[camel];
};
const authoredInput = (target, value) => {
    const keys = target === 'prepare_e_comet_feedback' ? ['kind', 'summary', 'details', 'includeTranscript'] : ['artifactId'];
    if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || !validateSchemaValue(value, toolInputSchemas[target]))
        throw Object.assign(new Error('The feedback arguments are invalid.'), { feedbackReason: 'invalid_input' });
    const input = Object.fromEntries(keys.map(key => [key, value[key]]));
    return input;
};

// Verified host representations only, with one bounded serialized layer. Never
// recurse through arbitrary response properties or accept a tool_output alias.
// A device refusal of prepare is reported as often as its evidence, so that caller
// allows an error envelope and validates the carried result itself.
export const normalizeCloudResponse = (response, { allowError = false } = {}) => {
    if (Buffer.byteLength(json(response) ?? '') > MAX_MCP_MESSAGE_BYTES) throw invalid();
    if (typeof response === 'string') response = parseHostJson(response);
    const candidates = [];
    let content;
    if (Array.isArray(response)) content = response;
    else if (record(response)) {
        if (response.isError !== undefined && response.isError !== false && !allowError) throw invalid();
        if (response.status === 'host_result_unavailable' || (allowError && typeof response.status === 'string')) candidates.push(response);
        else {
            for (const key of ['structuredContent', 'structured_content']) if (Object.hasOwn(response, key)) candidates.push(response[key]);
            if (response.content !== undefined && !Array.isArray(response.content)) throw invalid();
            content = response.content;
        }
    } else throw invalid();
    for (const item of content ?? []) {
        if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') throw invalid();
        candidates.push(parseHostJson(item.text));
    }
    if (!candidates.length || candidates.some(item => !equal(item, candidates[0]))) throw invalid();
    return candidates[0];
};

export const processCloudFeedbackEvent = async (event, options = {}) => {
    const now = options.cloud?.now ?? Date.now;
    const binding = { sessionId: trustedField(event, 'session_id', 'sessionId'),
        toolName: trustedField(event, 'tool_name', 'toolName'), callId: trustedField(event, 'tool_use_id', 'toolUseId') };
    const eventName = trustedField(event, 'hook_event_name', 'hookEventName');
    const target = binding.toolName.slice(PREFIX.length);
    if (!binding.toolName.startsWith(PREFIX) || !['prepare_e_comet_feedback', 'submit_e_comet_feedback'].includes(target)) throw invalid();
    const paths = cloudPaths(options.env ?? process.env);
    // Explicit artifactDirectory prevents canonical legacy/native-root fallback.
    const artifactOptions = { artifactDirectory: paths.artifacts, now };
    const retireArtifact = options.cloud?.retireArtifact ?? (value => retireFeedbackArtifact(value, artifactOptions));
    const store = new CloudFeedbackStore(paths, { now, ...options.cloud?.state });
    const input = hostValue(event, 'tool_input', 'toolInput');
    if (eventName === 'PreToolUse') {
        const authored = authoredInput(target, input);
        if (target === 'submit_e_comet_feedback') {
            // Lookup comes before the claim, staging or any upload. It works after archive, grant and
            // completed operation cleanup.
            const outcome = await store.readArtifactOutcome(binding.sessionId, authored.artifactId);
            if (blocksUpload(outcome)) {
                if (outcome.result.status === 'uploaded') await retireArtifact({ artifactId: authored.artifactId }).catch(() => undefined);
                return recoveryOutput(outcome.result);
            }
            let transport;
            try {
                // The claim reads the grant without consuming it: every refusal before the upload request sent
                // nothing and keeps it.
                transport = await claimUploadGrant({ dataDirectory: paths.handoff, sessionId: binding.sessionId,
                    artifactId: authored.artifactId, targetTool: target, nowMs: now(), consume: false });
            } catch (error) {
                const code = ['FEEDBACK_GRANT_MISSING', 'FEEDBACK_GRANT_REFRESH_REQUIRED'].includes(error?.code) ? error.code : 'FEEDBACK_SUBMISSION_FAILED';
                return notStartedOutput(safeFailure(error, authored.artifactId, 'not_started', code));
            }
            let marker;
            try {
                // A host that repeats PreToolUse for one call gets its own staged marker back.
                marker = await store.stage(binding, { authored, transport: Object.fromEntries(TRANSPORT_KEYS.map(key => [key, transport[key]])) }, authored);
            } catch (error) {
                return notStartedOutput(safeFailure(error, authored.artifactId, 'not_started', 'FEEDBACK_SUBMISSION_FAILED', UNRECORDED_KEPT_MESSAGE));
            }
            // The device answers this marker without any work; the PostToolUse below uploads from this sandbox.
            return hook({ hookEventName: 'PreToolUse', updatedInput: { ...authored,
                feedbackCloud: { version: FEEDBACK_CLOUD_TRANSPORT_VERSION, operationId: marker.operationId, nonce: marker.nonce } } });
        }
        // The cloud archive has the native budget, so the report is fitted exactly as on the native route.
        const { transcriptPath, ...fitted } = fitPrepareWireInput(prepareInputWithTrustedTranscript({ ...event, tool_input: authored, toolInput: authored }));
        const marker = await store.stage(binding, { authored: fitted, ...(transcriptPath ? { transcriptPath } : {}) }, authored);
        return hook({ hookEventName: 'PreToolUse', updatedInput: deviceInput(fitted, marker) });
    }
    if (eventName !== 'PostToolUse' && !(eventName === 'PostToolUseFailure' && target === 'prepare_e_comet_feedback')) throw invalid();
    const op = await store.readOperation(binding);
    const marker = op.marker;
    const postInput = record(input) ? { ...input } : undefined;
    let normalized;
    let response;
    if (target === 'submit_e_comet_feedback') {
        if (!postInput) throw invalid();
        // Like prepare, accept either the rewritten input or the authored one a host may report instead. The device
        // answer is never read: this hook uploads, and no device version adds anything the upload needs.
        if (Object.hasOwn(postInput, 'feedbackCloud')) {
            if (!isValidFeedbackCloudSubmitInput(postInput)
                || postInput.feedbackCloud.operationId !== marker.operationId || postInput.feedbackCloud.nonce !== marker.nonce) throw invalid();
            normalized = authoredInput(target, { artifactId: postInput.artifactId });
        } else normalized = authoredInput(target, postInput);
        if (!store.inputMatches(op, normalized)) throw invalid();
    } else {
        if (postInput && Object.hasOwn(postInput, 'feedbackAdapter')) {
            if (!isValidFeedbackHostAdapterInput(target, postInput) || !equal(postInput.feedbackAdapter, marker)
                || postInput.summary !== DEVICE_REPORT_TEXT || postInput.details !== DEVICE_REPORT_TEXT
                || (op.state === 'pending' && !equal(postInput, deviceInput(op.input.authored, marker)))) throw invalid();
        } else {
            normalized = authoredInput(target, postInput);
            if (!store.inputMatches(op, normalized)) throw invalid();
        }
        if (eventName === 'PostToolUseFailure') return prepareRefusalOutput(eventName);
        response = normalizeCloudResponse(hostValue(event, 'tool_response', 'toolResponse'), { allowError: true });
        if (response.status === 'failed' && validateSchemaValue(response, toolOutputSchemas.prepare_e_comet_feedback)) return prepareRefusalOutput(eventName);
        if (!isValidFeedbackHostAdapterResult(target, marker, response)) throw invalid();
    }
    const claim = await store.claimOperation(binding);
    if (claim.result) return postOutput(claim.result);
    if (!claim.owned) return postOutput(target === 'prepare_e_comet_feedback'
        ? feedbackPreparationFailure(invalid()) : safeFailure(undefined, normalized.artifactId));
    // Uploads the staged archive once. Every refusal before the request keeps the authorization for a repeat.
    const upload = async (artifactId, transport) => {
        const recorded = await store.readArtifactOutcome(binding.sessionId, artifactId);
        // Another call already started or ended this artifact's upload: its outcome answers this call too.
        if (blocksUpload(recorded)) return recorded.result;
        let artifact;
        try {
            artifact = await (options.cloud?.loadArtifact ?? (request => loadVerifiedFeedbackArtifact(request, artifactOptions)))(
                { artifactId, expectedSize: transport.expectedSize, expectedSha256: transport.expectedSha256 });
        } catch (error) {
            return safeFailure(error, artifactId, 'not_started', 'FEEDBACK_SUBMISSION_FAILED', ARCHIVE_KEPT_MESSAGE);
        }
        let attempt;
        try {
            // The intent is recorded before any request leaves this process: a lost outcome is uncertain, never absent.
            attempt = await store.beginUploadAttempt(binding.sessionId, { artifactId, sizeBytes: transport.expectedSize,
                sha256: transport.expectedSha256, transcriptIncluded: artifact.transcriptIncluded });
        } catch (error) {
            const concurrent = await store.readArtifactOutcome(binding.sessionId, artifactId).catch(() => undefined);
            return blocksUpload(concurrent) ? concurrent.result
                : safeFailure(error, artifactId, 'not_started', 'FEEDBACK_SUBMISSION_FAILED', UNRECORDED_KEPT_MESSAGE);
        }
        let socket;
        let unreachable;
        const requestImpl = (requestOptions, onResponse) => {
            const request = (options.cloud?.requestImpl ?? httpsRequest)(requestOptions, onResponse);
            request.once('socket', value => { socket = value; });
            return request;
        };
        // WHY: a TLS client socket is authorized exactly once its handshake succeeded, and only then can request bytes
        // leave it. The state is read when the request fails, because a direct socket arrives before it connects (and
        // already names a TLS protocol) while a proxy tunnel's arrives after the handshake.
        const tlsOpened = () => socket?.authorized === true;
        let result = await submitECometFeedback({ artifactId, ...transport }, {
            // This hook staged the grant itself, so it is the trusted party and issues no signature to check.
            verifySignature: () => true, now, retireArtifact, loadArtifact: async () => artifact,
            upload: grant => putFeedbackArchive(grant, { requestImpl, now,
                ...(forbidsOverwrite(grant.requiredHeaders) ? { acceptedStatuses: CREATE_ACCEPTED_STATUSES } : {}) })
                .catch(error => { if (!tlsOpened()) unreachable = error; throw error; }),
        });
        if (unreachable && result.status === 'uncertain') result = egressRefusal(unreachable, artifactId);
        else if (result.status === 'failed') result = keptGrant(result);
        await store.recordUploadOutcome(attempt, result);
        return result;
    };
    let result;
    const feedbackSession = createHash('sha256').update(binding.sessionId, 'utf8').digest('hex');
    try {
        if (target === 'prepare_e_comet_feedback') {
            const effective = { ...op.input.authored, ...(op.input.transcriptPath ? { transcriptPath: op.input.transcriptPath } : {}) };
            // The cloud hook prepares inside this process, so it is itself the trusted party: it never reads
            // the shared hook secret and issues no signature to verify against itself.
            result = await prepareECometFeedback({ ...effective, feedbackSession }, {
                verifySignature: () => true, now, route: 'cloud',
                getBridgeStatus: () => response.bridgeStatus,
                // The device's extension log, validated above as a bounded JSON array; the archive fit drops it
                // before report.md or metadata.json.
                ...(response.extensionLog === undefined ? {} : { extensionLogBytes: Buffer.from(response.extensionLog, 'utf8') }),
                registerArtifact: value => registerFeedbackArtifact(value, artifactOptions),
                ...(options.cloud?.readTranscript ? { readTranscript: options.cloud.readTranscript } : {}),
            });
            const { artifactId, kind, sizeBytes, sha256, transcriptIncluded } = result;
            await stagePreparedArtifact({ dataDirectory: paths.handoff, sessionId: binding.sessionId,
                metadata: { artifactId, kind, sizeBytes, sha256, transcriptIncluded }, nowMs: now() });
        } else result = await upload(normalized.artifactId, op.input.transport);
    } catch (error) {
        if (target === 'prepare_e_comet_feedback' && result?.status === 'prepared') {
            // Initial staging never exposed this archive to the model. Retire it
            // through canonical cleanup instead of leaving unreachable quota use.
            await retireArtifact({ artifactId: result.artifactId }).catch(() => undefined);
        }
        // If the authoritative attempt receipt cannot be published, future calls still cannot prove
        // no-send: accepted residual, see docs/local-agent-architecture.md#accepted-residuals.
        result = target === 'prepare_e_comet_feedback' ? feedbackPreparationFailure(error) : safeFailure(error, normalized.artifactId, 'uncertain');
        if (target === 'submit_e_comet_feedback') {
            try {
                const recorded = await store.readArtifactOutcome(binding.sessionId, normalized.artifactId);
                if (recorded) result = recorded.result;
            } catch { /* The saved outcome stays authoritative for later recovery. */ }
        }
    }
    // An upload that ended — accepted, refused by storage, or of unknown outcome — spends the
    // authorization it used: nothing may send this artifact again under it.
    if (target === 'submit_e_comet_feedback' && TERMINAL_UPLOAD_STATUSES.includes(result.status)) {
        await discardUploadGrant({ dataDirectory: paths.handoff, sessionId: binding.sessionId }).catch(() => undefined);
    }
    try { await store.finishOperation(binding, result); }
    catch {
        // Preparation publication and submit outcome selection have already completed. This operation
        // receipt is ancillary: its failure cannot change the selected outcome or erase device evidence.
        // The earlier path already retains uncertainty when the authoritative attempt write fails.
    }
    return postOutput(result);
};
