import { MAX_FILTER_QUERIES, MAX_CHECK_PAGES_PER_QUERY, MAX_CHECK_QUERIES, MAX_CHECK_SEARCH_REQUESTS, MAX_PRODUCT_CARD_PRODUCTS, MAX_PRODUCT_CARD_REQUEST_UNITS, MAX_RECOMMENDATION_PAGES_PER_PRODUCT, MAX_RECOMMENDATION_REQUEST_UNITS, MAX_SEARCH_PAGES_PER_QUERY, MAX_SEARCH_REQUEST_UNITS } from '../domain/constants/limits.const.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH, MAX_BROWSER_JOB_URL_LENGTH } from '../../transport/mcp/limits.mjs';
import { validTimeout } from '../../shared/timeouts.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { isAllowedWbUrl } from '../domain/policies/wb-url.policy.mjs';
import { buildCheckDescriptorUrl, buildDescriptorUrl, buildFiltersDescriptorUrl, fillTemplate, normalizeProductArticles } from '../domain/converters/descriptor-urls.converter.mjs';
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
const validEndpoint = (value) => {
    if (typeof value !== 'string' || value.length > MAX_BROWSER_JOB_URL_LENGTH)
        return false;
    return isAllowedWbUrl(value);
};
const validParams = (value) => value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.query === undefined &&
    value.page === undefined &&
    Object.entries(value).every(([key, item]) => boundedText(key) && boundedText(item));
const validProductArticle = (article) => article !== null &&
    typeof article === 'object' &&
    !Array.isArray(article) &&
    Number.isSafeInteger(article.nm) &&
    article.nm > 0 &&
    Object.values(article).every((value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)));
const cardUrlMatchesArticle = (cardUrl, article) => {
    try {
        return Number(new URL(cardUrl).searchParams.get('nm')) === article;
    }
    catch {
        return false;
    }
};
// The limits of a signed buyer or filters descriptor; any other job type is not this context's.
// Parse boundary: the grant as the extension sent it.
export const validateAuthorizedJobLimits = (authorization) => {
    try {
        const job = authorization?.job;
        if (!job || typeof job !== 'object' || Array.isArray(job) || !boundedText(job.jobId))
            throw brokenRule('descriptor', 'Browser job descriptor is invalid');
        if (!validJobTimeout(job))
            throw brokenRule('timeout', 'Browser job timeout is invalid');
        if (authorization.jobType === 'search_by_query') {
            const queries = job.queries;
            if (job.type !== 'wb-search-by-query')
                throw brokenRule('type', 'Invalid search descriptor type');
            if (!validEndpoint(job.endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(job.params))
                throw brokenRule('params', 'Invalid browser job params');
            if (!Array.isArray(queries) ||
                queries.length < 1 ||
                !queries.every((item) => Array.isArray(item) &&
                    item.length === 2 &&
                    boundedText(item[0]) &&
                    item[0].trim().length > 0 &&
                    Number.isInteger(item[1]) &&
                    item[1] >= 1))
                throw brokenRule('queries', 'Invalid browser job queries');
            if (queries.some(([, pages]) => pages > MAX_SEARCH_PAGES_PER_QUERY))
                throw brokenRule('pages', `Browser search job requires at most ${MAX_SEARCH_PAGES_PER_QUERY} pages per query`);
            if (queries.reduce((total, [, pages]) => total + pages, 0) > MAX_SEARCH_REQUEST_UNITS)
                throw brokenRule('requests', `Browser search job requires at most ${MAX_SEARCH_REQUEST_UNITS} total pages`);
            if (!descriptorPagesAllowed(job.endpoint, job.params, queries))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
            return;
        }
        if (authorization.jobType === 'check_by_query') {
            const queries = job.queries;
            if (job.type !== 'wb-check-by-query')
                throw brokenRule('type', 'Invalid check-by-query descriptor type');
            if (!Number.isSafeInteger(job.article) || job.article <= 0)
                throw brokenRule('product', 'Invalid check-by-query product');
            if (!validEndpoint(job.cardUrl) || !cardUrlMatchesArticle(job.cardUrl, job.article))
                throw brokenRule('card_url', 'Invalid check-by-query card URL');
            if (!validEndpoint(job.endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(job.params) || job.params.fbrand !== undefined || job.params.resultset !== undefined)
                throw brokenRule('params', 'Invalid browser job params');
            if (!Array.isArray(queries) ||
                queries.length < 1 ||
                queries.length > MAX_CHECK_QUERIES ||
                !queries.every((query) => boundedText(query) && query.trim().length > 0) ||
                new Set(queries).size !== queries.length)
                throw brokenRule('queries', `Browser check-by-query job requires 1-${MAX_CHECK_QUERIES} unique queries`);
            if (job.maxPages !== MAX_CHECK_PAGES_PER_QUERY)
                throw brokenRule('pages', `Browser check-by-query job requires exactly ${MAX_CHECK_PAGES_PER_QUERY} pages per query`);
            if (queries.length * job.maxPages > MAX_CHECK_SEARCH_REQUESTS)
                throw brokenRule('requests', `Browser check-by-query job requires at most ${MAX_CHECK_SEARCH_REQUESTS} search requests`);
            if (!descriptorCheckPagesAllowed(job, queries))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
            return;
        }
        if (authorization.jobType === 'filters_by_query') {
            const queries = job.queries;
            if (job.type !== 'wb-filters-by-query')
                throw brokenRule('type', 'Invalid filters-by-query descriptor type');
            if (!validEndpoint(job.endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(job.params) || job.params.resultset !== undefined || job.params.filters !== undefined)
                throw brokenRule('params', 'Invalid browser job params');
            if (!Array.isArray(queries) ||
                queries.length < 1 ||
                queries.length > MAX_FILTER_QUERIES ||
                !queries.every((query) => boundedText(query) && query.trim().length > 0) ||
                new Set(queries).size !== queries.length)
                throw brokenRule('queries', `Browser filters-by-query job requires 1-${MAX_FILTER_QUERIES} unique queries`);
            if (!queries.every((query) => isAllowedWbUrl(buildFiltersDescriptorUrl(job, query))))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
            return;
        }
        if (authorization.jobType === 'product_card') {
            const articles = job.articles;
            const endpoints = job.endpoints;
            if (job.type !== 'wb-product-card')
                throw brokenRule('type', 'Invalid product-card descriptor type');
            if (!Array.isArray(articles) || articles.length < 1 || !articles.every(validProductArticle))
                throw brokenRule('articles', 'Invalid browser job articles');
            if (articles.length > MAX_PRODUCT_CARD_PRODUCTS)
                throw brokenRule('requests', `Browser product-card job requires at most ${MAX_PRODUCT_CARD_PRODUCTS} products`);
            if (!Array.isArray(endpoints) ||
                endpoints.length < 1 ||
                !endpoints.every((endpoint) => boundedText(endpoint?.key) &&
                    typeof endpoint?.url === 'string' &&
                    endpoint.url.length >= 1 &&
                    endpoint.url.length <= MAX_BROWSER_JOB_URL_LENGTH))
                throw brokenRule('endpoints', 'Invalid browser job endpoints');
            if (articles.length * endpoints.length > MAX_PRODUCT_CARD_REQUEST_UNITS)
                throw brokenRule('requests', `Browser product-card job requires at most ${MAX_PRODUCT_CARD_REQUEST_UNITS} requests`);
            if (!articles.every((article) => endpoints.every((endpoint) => isAllowedWbUrl(fillTemplate(endpoint.url, article)))))
                throw brokenRule('assembled_url', 'Invalid browser job expanded endpoint URL');
            return;
        }
        if (authorization.jobType === 'recommendations_by_product') {
            const articles = job.articles;
            if (job.type !== 'wb-recommendations-by-product')
                throw brokenRule('type', 'Invalid recommendations descriptor type');
            if (!validEndpoint(job.endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(job.params))
                throw brokenRule('params', 'Invalid browser job params');
            if (!Array.isArray(articles) ||
                articles.length < 1 ||
                !articles.every((item) => Array.isArray(item) &&
                    (item.length === 1 || item.length === 2) &&
                    Number.isSafeInteger(item[0]) &&
                    item[0] > 0 &&
                    (item.length === 1 || (Number.isInteger(item[1]) && item[1] >= 1))))
                throw brokenRule('articles', 'Invalid browser job recommendation articles');
            if (new Set(articles.map(([nm]) => nm)).size !== articles.length)
                throw brokenRule('unique_products', 'Browser recommendations job requires unique products');
            if (articles.some((item) => item[1] !== undefined && item[1] > MAX_RECOMMENDATION_PAGES_PER_PRODUCT))
                throw brokenRule('pages', `Browser recommendations job requires at most ${MAX_RECOMMENDATION_PAGES_PER_PRODUCT} pages per product`);
            if (articles.reduce((total, item) => total + (item[1] ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT), 0) >
                MAX_RECOMMENDATION_REQUEST_UNITS)
                throw brokenRule('requests', `Browser recommendations job requires at most ${MAX_RECOMMENDATION_REQUEST_UNITS} total pages`);
            if (!descriptorPagesAllowed(job.endpoint, job.params, articles.map(([nm, pages]) => [String(nm), pages ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT])))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
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
const descriptorPagesAllowed = (endpoint, params, scopes) => scopes.every(([query, pages]) => {
    for (let page = 1; page <= pages; page += 1) {
        if (!isAllowedWbUrl(buildDescriptorUrl(endpoint, params, query, page)))
            return false;
    }
    return true;
});
const descriptorCheckPagesAllowed = (job, queries) => queries.every((query) => {
    for (let page = 1; page <= job.maxPages; page += 1) {
        // The extension derives fbrand from WB card data, so reserve URL space for every valid brand identity.
        if (!isAllowedWbUrl(buildCheckDescriptorUrl(job, query, page, Number.MAX_SAFE_INTEGER)))
            return false;
    }
    return true;
});
// The job stopped mid-run: say how many WB requests were answered (their rows are in the result file) and, when the
// signed budget is known, how many were not. Each job gets its own copy; one cause can end several jobs at once.
export const stoppedWbJobError = (error, authorization, answered) => {
    const stopped = new ToolExecutionError(error.code, error.message, error.stage, error.retryable, { cause: error });
    const budget = signedRequests(authorization);
    stopped.details = { ...error.details, completed: answered, ...(budget === undefined ? {} : { pending: Math.max(0, budget - answered) }) };
    return stopped;
};
// The signed request budget, undefined for a job type not listed here; check_by_query and recommendations may stop
// early, and filters_by_query asks for a full list only when a phrase has lists to expand, so for them it is an upper bound.
const signedRequests = ({ jobType, job }) => jobType === 'search_by_query' ? job.queries.reduce((total, [, pages]) => total + pages, 0)
    : jobType === 'check_by_query' ? 1 + job.queries.length * job.maxPages
        : jobType === 'filters_by_query' ? job.queries.length * 2
            : jobType === 'product_card' ? normalizeProductArticles(job.articles).length * job.endpoints.length
                : jobType === 'recommendations_by_product'
                    ? job.articles.reduce((total, [, pages]) => total + (pages ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT), 0)
                    : undefined;
