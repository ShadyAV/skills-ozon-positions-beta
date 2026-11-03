import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../transport/mcp/limits.mjs';
import { validTimeout } from '../../shared/timeouts.mjs';
import { parseAnalyticsReports } from '../domain/policies/analytics.policy.mjs';
import { parseOzonPromotionPeriod } from '../domain/policies/promotion.policy.mjs';
import { parsePromotionPeriods } from '../domain/policies/package.policy.mjs';
import { canonicalSearchPositionsRequest, sameSearchPositionsRequest } from '../domain/policies/search-positions.policy.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
// Parse boundary: the signed job, read field by field.
const validJobTimeout = (job) => job.timeout === undefined || validTimeout(job.timeout);
// Each broken limit names its closed rule (DESCRIPTOR_RULES in transport/failures); the message stays in the log only.
const brokenRule = (rule, message) => Object.assign(new Error(message), { rule });
// Parse boundary: whatever a check threw; only a broken rule carries its name.
const invalidDescriptor = (cause) => {
    const error = new ToolExecutionError('BROWSER_JOB_DESCRIPTOR_INVALID', 
    // The same job is signed the same way, so another authorization fails the same way.
    'The signed browser job descriptor is invalid; this is an e-Comet defect. Offer to report it; do not request another authorization for the same job.', 'authorization', false, { cause: cause instanceof Error ? cause : new Error(String(cause)) });
    if (typeof cause?.rule === 'string')
        error.details = Object.freeze({ rule: cause.rule });
    return error;
};
const boundedText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
// A buyer, filters or seller job is checked by its own context's rules, which `foreignJobs` brings: an Ozon job checks a
// foreign signed job by its own type's limits before it refuses that type, so the refusal stays the job-type mismatch.
// Without `foreignJobs` only the Ozon job types pass.
// Parse boundary: the signed grant, read field by field.
export const validateAuthorizedJobLimits = (authorization, foreignJobs = undefined) => {
    if (foreignJobs?.validate(authorization))
        return;
    try {
        const job = authorization?.job;
        if (!job || typeof job !== 'object' || Array.isArray(job) || !boundedText(job.jobId))
            throw brokenRule('descriptor', 'Browser job descriptor is invalid');
        if (!validJobTimeout(job))
            throw brokenRule('timeout', 'Browser job timeout is invalid');
        if (authorization.jobType === 'ozon_seller_promotion_report') {
            const keys = Object.keys(job);
            if (keys.length !== 4 ||
                !keys.every((key) => ['jobId', 'type', 'dateFrom', 'dateTo'].includes(key)) ||
                job.type !== 'ozon-seller-promotion-report') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon promotion descriptor');
            }
            try {
                parseOzonPromotionPeriod(job.dateFrom, job.dateTo);
            }
            catch (error) {
                throw brokenRule('ozon_items', error.message);
            }
            return;
        }
        if (authorization.jobType === 'ozon_seller_promotion_reports') {
            const keys = Object.keys(job);
            if (keys.length !== 3 ||
                !keys.every((key) => ['jobId', 'type', 'periods'].includes(key)) ||
                job.type !== 'ozon-seller-promotion-reports') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon promotion package descriptor');
            }
            try {
                parsePromotionPeriods(job.periods);
            }
            catch (error) {
                throw brokenRule('ozon_items', error.message);
            }
            return;
        }
        if (authorization.jobType === 'ozon_seller_analytics_report') {
            const keys = Object.keys(job);
            if (keys.length !== 3 ||
                !keys.every((key) => ['jobId', 'type', 'reports'].includes(key)) ||
                job.type !== 'ozon-seller-analytics-report') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon analytics descriptor');
            }
            try {
                parseAnalyticsReports(job.reports, authorization.issuedAt);
            }
            catch (error) {
                throw brokenRule('ozon_items', error.message);
            }
            return;
        }
        if (authorization.jobType === 'ozon_search_positions') {
            const keys = Object.keys(job);
            if (keys.length !== 6 ||
                !keys.every((key) => ['jobId', 'type', 'queries', 'skus', 'region', 'platform'].includes(key)) ||
                job.type !== 'ozon-search-positions') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon search positions descriptor');
            }
            // The signer materializes defaults and trims, so a signed descriptor is already canonical. A signer trimming
            // other whitespace than ECMAScript fails closed here: accepted residual, see
            // docs/local-agent-architecture.md#accepted-residuals.
            const { queries, skus, region, platform } = job;
            if (!sameSearchPositionsRequest(canonicalSearchPositionsRequest({ queries, skus, region, platform }), job)) {
                throw brokenRule('ozon_canonical', 'Ozon search positions descriptor is not canonical');
            }
            return;
        }
        throw brokenRule('job_type', `Unsupported browser_job type: ${authorization.jobType}`);
    }
    catch (error) {
        if (error instanceof ToolExecutionError)
            throw error;
        throw invalidDescriptor(error);
    }
};
