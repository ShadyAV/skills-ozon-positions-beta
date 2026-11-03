import { MAX_SELLER_REVIEW_EXPORTS, MAX_SELLER_REVIEW_PHYSICAL_REPORTS } from '../domain/constants/limits.const.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../transport/mcp/limits.mjs';
import { validTimeout } from '../../shared/timeouts.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
const validJobTimeout = (job) => job.timeout === undefined || validTimeout(job.timeout);
// Each broken limit names its closed rule (DESCRIPTOR_RULES in transport/failures); the message stays in the log only.
const brokenRule = (rule, message) => Object.assign(new Error(message), { rule });
const invalidDescriptor = (cause) => {
    const error = new ToolExecutionError('BROWSER_JOB_DESCRIPTOR_INVALID', 
    // The same job is signed the same way, so another authorization fails the same way.
    'The signed browser job descriptor is invalid; this is an e-Comet defect. Offer to report it; do not request another authorization for the same job.', 'authorization', false, { cause: cause instanceof Error ? cause : new Error(String(cause)) });
    const rule = cause?.rule;
    if (typeof rule === 'string')
        error.details = Object.freeze({ rule });
    return error;
};
const boundedText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
const validIsoDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const validSellerOrg = (org) => {
    if (org === undefined)
        return true;
    if (!org || typeof org !== 'object' || Array.isArray(org))
        return false;
    const keys = Object.keys(org);
    return keys.length === 1 && (keys[0] === 'id' || keys[0] === 'name') && boundedText(org[keys[0]]);
};
const validSellerRatings = (ratings) => ratings === undefined ||
    (Array.isArray(ratings) &&
        ratings.length >= 1 &&
        ratings.length <= 5 &&
        ratings.every((rating) => Number.isSafeInteger(rating) && rating >= 1 && rating <= 5) &&
        new Set(ratings).size === ratings.length);
const sellerExportIdentity = (sellerExport) => JSON.stringify({
    product_id: sellerExport.product_id ?? null,
    dateFrom: sellerExport.dateFrom ?? null,
    dateTo: sellerExport.dateTo ?? null,
    isAnswered: sellerExport.isAnswered ?? null,
    ratings: sellerExport.ratings === undefined ? null : [...sellerExport.ratings].sort((left, right) => left - right),
    content: sellerExport.content ?? null,
});
// The limits of a signed seller_reviews descriptor; any other job type is not this context's.
// Parse boundary: the grant as the extension sent it.
export const validateAuthorizedJobLimits = (authorization) => {
    try {
        const job = authorization?.job;
        if (!job || typeof job !== 'object' || Array.isArray(job) || !boundedText(job.jobId))
            throw brokenRule('descriptor', 'Browser job descriptor is invalid');
        if (!validJobTimeout(job))
            throw brokenRule('timeout', 'Browser job timeout is invalid');
        if (authorization.jobType === 'seller_reviews') {
            const exports = job.exports;
            const validSellerReviews = job.type === 'wb-seller-reviews' &&
                validSellerOrg(job.org) &&
                Array.isArray(exports) &&
                exports.length >= 1 &&
                exports.length <= MAX_SELLER_REVIEW_EXPORTS &&
                exports.every((item) => item &&
                    typeof item === 'object' &&
                    !Array.isArray(item) &&
                    Object.keys(item).every((key) => ['product_id', 'dateFrom', 'dateTo', 'isAnswered', 'ratings', 'content'].includes(key)) &&
                    (item.product_id === undefined || (Number.isSafeInteger(item.product_id) && item.product_id > 0)) &&
                    (item.isAnswered === undefined || typeof item.isAnswered === 'boolean') &&
                    validSellerRatings(item.ratings) &&
                    (item.content === undefined || item.content === 'media') &&
                    ((item.dateFrom === undefined && item.dateTo === undefined) ||
                        (validIsoDate(item.dateFrom) && validIsoDate(item.dateTo) && item.dateFrom <= item.dateTo))) &&
                new Set(exports.map(sellerExportIdentity)).size === exports.length &&
                exports.reduce((total, item) => total + (item.isAnswered === undefined ? 2 : 1), 0) <=
                    MAX_SELLER_REVIEW_PHYSICAL_REPORTS;
            if (!validSellerReviews) {
                throw brokenRule('seller_exports', `Browser seller-review job requires at most ${MAX_SELLER_REVIEW_EXPORTS} exports and ${MAX_SELLER_REVIEW_PHYSICAL_REPORTS} physical reports`);
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
