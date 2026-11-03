import { RECOMMENDATION_PAGE_SIZE } from '../constants/limits.const.mjs';
// Parse boundary: a WB answer as the extension relayed it.
export const isSuccessfulWbResponse = (response) => !response?.error &&
    response?.data?.ok !== false &&
    typeof response?.data?.status === 'number' &&
    response.data.status >= 200 &&
    response.data.status < 300;
export const normalizeStatus = (succeeded, total) => (succeeded === total ? 'done' : succeeded === 0 ? 'failed' : 'partial');
export const recommendationTotalPages = (total) => {
    if (total === undefined || !Number.isInteger(total) || total < 0) {
        return null;
    }
    return Math.max(1, Math.ceil(total / RECOMMENDATION_PAGE_SIZE));
};
