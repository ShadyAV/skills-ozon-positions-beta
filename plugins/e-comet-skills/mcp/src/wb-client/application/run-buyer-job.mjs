import { CHECK_QUERY_CONCURRENCY, DEFAULT_RETURNED_PRODUCTS, FILTER_QUERY_CONCURRENCY, MAX_RECOMMENDATION_PAGES_PER_PRODUCT, MAX_RETURNED_PRODUCTS, PRODUCT_CARD_CONCURRENCY, RECOMMENDATION_CONCURRENCY, SEARCH_CONCURRENCY } from '../domain/constants/limits.const.mjs';
import { REQUEST_TIMEOUT_MS } from '../../shared/timeouts.mjs';
import { FETCH_ERROR_CODES, wbaasRecoveryOutcome } from '../../transport/extension/wire.mjs';
import { countRunProgress } from '../../shared/run-progress.mjs';
import { closedFailureDetails } from '../../transport/failures/vocabulary.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { isAllowedWbUrl } from '../domain/policies/wb-url.policy.mjs';
import { isSuccessfulWbResponse, normalizeStatus, recommendationTotalPages } from '../domain/policies/response.policy.mjs';
import { numberOrUndefined, projectPageProducts, responseProducts, summarizeProduct } from '../domain/converters/products.converter.mjs';
import { completeFilters, fullListKeys, keptFilters, mergeFilters, readFiltersResponse } from '../domain/converters/filters.converter.mjs';
import { buildCheckDescriptorUrl, buildDescriptorUrl, buildFiltersDescriptorUrl, fillTemplate, normalizeProductArticles } from '../domain/converters/descriptor-urls.converter.mjs';
import { runWithConcurrency } from './concurrency.mjs';
import { stoppedWbJobError, validateAuthorizedJobLimits } from './job-limits.mjs';
// Пробрасываем и отказ авторизации, и потерю транспорта: мёртвый мост — не провал
// отдельной единицы, остальные упадут так же. Раньше при числе единиц не больше
// параллелизма задание резолвилось как обычный «провал» без признака retryable, и
// агент не понимал, что достаточно повторить.
const ABORTING_STAGES = new Set(['authorization', 'extension']);
const WB_ITEM_ERROR_CODES = Object.freeze([
    ...Object.values(FETCH_ERROR_CODES), 'WB_FETCH_FAILED', 'WB_RATE_LIMITED', 'WB_REQUEST_FAILED',
    'WB_UNRELIABLE_RESPONSE', 'WB_FULL_LISTS_INCOMPLETE',
]);
const skippedBuyerErrors = new WeakSet();
// A buyer item's errorDetails keep only the closed timeout phase and WBAAS recovery outcome (spec 7.2, 7.4).
const buyerEvidence = (details) => {
    const { phase, recovery } = /** @type {any} */ (closedFailureDetails(details) ?? {});
    return { ...(phase ? { phase } : {}), ...(recovery ? { recovery } : {}) };
};
// Parse boundary: a unit failure may be anything a fetch or a writer threw; only a coded error keeps its code.
const buyerErrorFields = (error) => ({
    error: error.message,
    errorDetails: {
        code: error instanceof ToolExecutionError && WB_ITEM_ERROR_CODES.includes(error.code) ? error.code : 'WB_REQUEST_FAILED',
        stage: 'execution',
        retryable: error instanceof ToolExecutionError ? error.retryable : false,
        ...(error instanceof ToolExecutionError ? buyerEvidence(error.details) : {}),
    },
    ...(skippedBuyerErrors.has(error) ? { skipped: true } : {}),
});
const buyerResponseErrorFields = (response) => {
    const recovery = wbaasRecoveryOutcome(response?.wbaasRecovery);
    if (response?.data?.status === 429) {
        const error = new ToolExecutionError('WB_RATE_LIMITED', 'Wildberries rate limited this job. No additional work was scheduled after this response.', 'execution', false);
        if (recovery)
            error.details = { recovery };
        return buyerErrorFields(error);
    }
    return recovery && !isSuccessfulWbResponse(response)
        ? { errorDetails: { code: 'WB_REQUEST_FAILED', stage: 'execution', retryable: false, recovery } }
        : {};
};
// The HTTP status of a failed WB answer, for check_by_query rows that otherwise keep only the text.
const failedHttpStatus = (response) => !isSuccessfulWbResponse(response) && Number.isSafeInteger(response?.data?.status) ? { httpStatus: response.data.status } : {};
// WB's catalog search answers no results with HTTP 200 metadata without `products`. The plain search answers
// `products: []` instead (live WB, 2026-10-27), so only wb_check_by_query uses this.
const isMetadataOnlyNoResult = (response) => {
    const body = response?.data?.body;
    return isSuccessfulWbResponse(response) && body !== null && typeof body === 'object' && typeof body.name === 'string' &&
        typeof body.query === 'string' && body.shardKey === 'merger' && body.search_result !== null &&
        typeof body.search_result === 'object' && !Object.hasOwn(body, 'products');
};
const rethrowAuthorizationError = (error) => {
    if (error instanceof ToolExecutionError && ABORTING_STAGES.has(error.stage)) {
        throw error;
    }
};
// Parse boundary: the card body WB answered.
const compactCardBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return undefined;
    return {
        imtId: numberOrUndefined(body.imt_id),
        nmId: numberOrUndefined(body.nm_id),
        vendorCode: typeof body.vendor_code === 'string' ? body.vendor_code : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        subjectId: numberOrUndefined(body.subj_id) ?? numberOrUndefined(body.subject_id),
        subject: typeof body.subj_name === 'string' ? body.subj_name : typeof body.subject_name === 'string' ? body.subject_name : undefined,
        rootSubject: typeof body.subj_root_name === 'string'
            ? body.subj_root_name
            : typeof body.root_subject_name === 'string'
                ? body.root_subject_name
                : undefined,
        options: Array.isArray(body.options) ? body.options : undefined,
        colors: Array.isArray(body.colors) ? body.colors.filter((value) => Number.isSafeInteger(value) && value > 0) : undefined,
    };
};
const executeSearchJob = async ({ authorizationId, job, requestWbFetch, writer, projection }) => {
    const units = job.queries.flatMap(([query, pages], queryIndex) => Array.from({ length: pages }, (_, index) => ({
        queryIndex,
        query,
        page: index + 1,
        url: buildDescriptorUrl(job.endpoint, job.params, query, index + 1),
    })));
    const fetched = await runWithConcurrency(units, SEARCH_CONCURRENCY, countRunProgress(units.length, async (unit) => {
        try {
            const response = await requestWbFetch(unit.url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, response, ...buyerResponseErrorFields(response) });
            return {
                ...unit,
                response,
                ...buyerResponseErrorFields(response),
                ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
            };
        }
        catch (error) {
            rethrowAuthorizationError(error);
            await writer.append({
                jobId: job.jobId,
                ...unit,
                ...buyerErrorFields(error),
            });
            return { ...unit, ok: false, ...buyerErrorFields(error) };
        }
    }));
    const queries = job.queries.map(([query, pagesRequested], queryIndex) => {
        let globalOffset = 0;
        let returnedProducts = 0;
        let globalPositionsReliable = true;
        const pages = fetched
            .filter((unit) => unit.queryIndex === queryIndex)
            .sort((left, right) => left.page - right.page)
            .map((unit) => {
            const products = responseProducts(unit.response);
            const productLimit = projection.productNmIds ? MAX_RETURNED_PRODUCTS : projection.productLimitPerScope;
            const remaining = Math.max(0, productLimit - returnedProducts);
            const pageGlobalPositionsReliable = globalPositionsReliable && unit.ok;
            const selected = unit.ok
                ? projectPageProducts(products, globalOffset, projection.productNmIds, remaining, pageGlobalPositionsReliable)
                : [];
            returnedProducts += selected.length;
            const page = {
                page: unit.page,
                ok: unit.ok,
                httpStatus: unit.response?.data?.status,
                total: products.length,
                overallTotal: numberOrUndefined(unit.response?.data?.body?.total),
                globalPositionsReliable: pageGlobalPositionsReliable,
                products: selected,
            };
            if (!unit.ok) {
                Object.assign(page, unit.errorDetails ? { errorDetails: unit.errorDetails } : {}, unit.skipped ? { skipped: true } : {});
                page.error = unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB search request failed';
            }
            if (!unit.ok)
                globalPositionsReliable = false;
            globalOffset += products.length;
            return page;
        });
        return {
            query,
            pagesRequested,
            pagesSucceeded: pages.filter((page) => page.ok).length,
            productsSeen: pages.reduce((total, page) => total + page.total, 0),
            productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
            globalPositionsComplete: pages.every((page) => page.globalPositionsReliable),
            pages,
        };
    });
    const succeeded = fetched.filter((unit) => unit.ok).length;
    return {
        ok: succeeded > 0,
        status: normalizeStatus(succeeded, fetched.length),
        pagesRequested: fetched.length,
        pagesSucceeded: succeeded,
        pagesFailed: fetched.length - succeeded,
        productFilterApplied: Boolean(projection.productNmIds),
        productLimitPerQuery: projection.productNmIds ? undefined : projection.productLimitPerScope,
        queries,
    };
};
const executeCheckByQueryJob = async ({ authorizationId, job, requestWbFetch, writer }) => {
    // product_id is the public tool terminology; article is retained only in the signed wire descriptor.
    const productId = job.article;
    let cardResponse;
    try {
        cardResponse = await requestWbFetch(job.cardUrl, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
        await writer.append({ jobId: job.jobId, kind: 'card', product_id: productId, url: job.cardUrl, response: cardResponse });
    }
    catch (error) {
        rethrowAuthorizationError(error);
        await writer.append({ jobId: job.jobId, kind: 'card', product_id: productId, url: job.cardUrl, ...buyerErrorFields(error) });
        return {
            ok: false,
            status: 'failed',
            complete: false,
            product_id: productId,
            requestsMade: 1,
            queries: job.queries.map((query) => ({
                query,
                found: false,
                pagesChecked: 0,
                completionReason: 'card_failed',
                ...buyerErrorFields(error),
            })),
        };
    }
    const cardProducts = responseProducts(cardResponse);
    const cardProduct = cardProducts.find((product) => numberOrUndefined(product?.id) === productId);
    const brandId = numberOrUndefined(cardProduct?.brandId);
    if (!isSuccessfulWbResponse(cardResponse) || brandId === undefined || !Number.isSafeInteger(brandId) || brandId <= 0) {
        const error = !isSuccessfulWbResponse(cardResponse)
            ? cardResponse?.error || cardResponse?.data?.statusText || 'WB product-card request failed'
            : 'WB product card did not contain a valid brand';
        return {
            ok: false,
            status: 'failed',
            complete: false,
            product_id: productId,
            product: {
                nmId: numberOrUndefined(cardProduct?.id) ?? productId,
                name: typeof cardProduct?.name === 'string' ? cardProduct.name : undefined,
                brand: typeof cardProduct?.brand === 'string' ? cardProduct.brand : undefined,
            },
            requestsMade: 1,
            queries: job.queries.map((query) => ({
                query,
                found: false,
                pagesChecked: 0,
                completionReason: 'card_failed',
                error,
                ...failedHttpStatus(cardResponse),
                ...buyerResponseErrorFields(cardResponse),
            })),
        };
    }
    let searchRequestsMade = 0;
    const queries = await runWithConcurrency(job.queries, CHECK_QUERY_CONCURRENCY, countRunProgress(job.queries.length, async (query) => {
        let previousFingerprint;
        for (let page = 1; page <= job.maxPages; page += 1) {
            const url = buildCheckDescriptorUrl(job, query, page, brandId);
            let response;
            try {
                searchRequestsMade += 1;
                response = await requestWbFetch(url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
                await writer.append({ jobId: job.jobId, kind: 'search', query, page, url, response });
            }
            catch (error) {
                rethrowAuthorizationError(error);
                if (skippedBuyerErrors.has(error))
                    searchRequestsMade -= 1;
                await writer.append({ jobId: job.jobId, kind: 'search', query, page, url, ...buyerErrorFields(error) });
                return {
                    query,
                    found: false,
                    pagesChecked: page - 1,
                    completionReason: 'request_failed',
                    ...buyerErrorFields(error),
                };
            }
            const hasProductArray = Array.isArray(response?.data?.body?.products);
            const products = hasProductArray ? responseProducts(response) : [];
            if (!isSuccessfulWbResponse(response) || (!hasProductArray && !isMetadataOnlyNoResult(response))) {
                return {
                    query,
                    found: false,
                    pagesChecked: page - 1,
                    completionReason: 'request_failed',
                    ...failedHttpStatus(response),
                    ...buyerResponseErrorFields(response),
                    error: response?.error || response?.data?.statusText || 'WB search request failed',
                };
            }
            const position = products.findIndex((product) => numberOrUndefined(product?.id) === productId);
            if (position >= 0) {
                return {
                    query,
                    found: true,
                    pagesChecked: page,
                    completionReason: 'found',
                };
            }
            if (products.length === 0) {
                return { query, found: false, pagesChecked: page, completionReason: 'empty_page' };
            }
            const fingerprint = JSON.stringify(products.map((product) => numberOrUndefined(product?.id) ?? null));
            if (fingerprint === previousFingerprint) {
                return { query, found: false, pagesChecked: page, completionReason: 'repeated_page' };
            }
            previousFingerprint = fingerprint;
        }
        return {
            query,
            found: false,
            pagesChecked: job.maxPages,
            completionReason: 'page_limit',
        };
    }));
    const successfulQueries = queries.filter((query) => query.completionReason !== 'request_failed').length;
    return {
        ok: successfulQueries > 0,
        status: normalizeStatus(successfulQueries, queries.length),
        complete: successfulQueries === queries.length,
        product_id: productId,
        product: {
            nmId: numberOrUndefined(cardProduct?.id) ?? productId,
            name: typeof cardProduct?.name === 'string' ? cardProduct.name : undefined,
            brand: typeof cardProduct?.brand === 'string' ? cardProduct.brand : undefined,
        },
        requestsMade: 1 + searchRequestsMade,
        queries,
    };
};
const filtersItemError = (code, message) => buyerErrorFields(new ToolExecutionError(code, message, 'execution', false));
const filtersResponseFailure = (response) => {
    // A 200 whose body cannot be read carries statusText "OK", which names no failure.
    const message = response?.error ||
        (response?.data?.ok ? 'Wildberries returned an unreadable filters response' : response?.data?.statusText) ||
        'WB filters request failed';
    // A failed answer keeps the anti-bot recovery outcome and its HTTP status, as the other WB rows do: over HTTP/2 the
    // browser gives no status text, so the message alone cannot tell a 498 from a 403 or a 500.
    return response?.data?.status === 429
        ? { ...buyerResponseErrorFields(response), ...failedHttpStatus(response), error: message }
        : { ...filtersItemError('WB_REQUEST_FAILED', message), ...buyerResponseErrorFields(response), ...failedHttpStatus(response), error: message };
};
// Per phrase: the filters WB shows, then one request for every truncated characteristic and category list. A decoy body or a
// list WB did not expand is reported, never passed off as data.
const executeFiltersByQueryJob = async ({ authorizationId, job, requestWbFetch, writer }) => {
    let requestsMade = 0;
    const fetchFilters = async (query, filterKeys) => {
        const kind = filterKeys ? 'full_lists' : 'filters';
        const url = buildFiltersDescriptorUrl(job, query, filterKeys);
        requestsMade += 1;
        try {
            const response = await requestWbFetch(url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, kind, query, url, response });
            return { response };
        }
        catch (error) {
            rethrowAuthorizationError(error);
            if (skippedBuyerErrors.has(error))
                requestsMade -= 1;
            await writer.append({ jobId: job.jobId, kind, query, url, ...buyerErrorFields(error) });
            return { error };
        }
    };
    const decoy = () => filtersItemError('WB_UNRELIABLE_RESPONSE', 'Wildberries returned a decoy filters response for this phrase.');
    const phrases = await runWithConcurrency(job.queries, FILTER_QUERY_CONCURRENCY, countRunProgress(job.queries.length, async (query) => {
        const first = await fetchFilters(query);
        if (first.error) {
            return { query, status: skippedBuyerErrors.has(first.error) ? 'rate_limited' : 'request_failed', ...buyerErrorFields(first.error) };
        }
        const listed = readFiltersResponse(first.response);
        if (listed.state === 'decoy')
            return { query, status: 'request_failed', ...decoy() };
        if (listed.state === 'failed')
            return { query, status: 'request_failed', ...filtersResponseFailure(first.response) };
        if (listed.filters.length === 0)
            return { query, status: 'empty', filterKeys: [], filters: [] };
        const kept = keptFilters(listed.filters);
        const keys = fullListKeys(kept);
        let fullFilters;
        let fullFailure;
        if (keys.length > 0 && isAllowedWbUrl(buildFiltersDescriptorUrl(job, query, keys))) {
            const second = await fetchFilters(query, keys);
            const full = second.error ? undefined : readFiltersResponse(second.response);
            if (second.error)
                fullFailure = buyerErrorFields(second.error);
            else if (full.state === 'genuine')
                fullFilters = full.filters;
            else
                fullFailure = full.state === 'decoy' ? decoy() : filtersResponseFailure(second.response);
        }
        const { filters, missing } = completeFilters(kept, fullFilters);
        const filterKeys = filters.map((filter) => filter.key);
        if (missing === 0)
            return { query, status: 'ok', filterKeys, filters };
        return {
            query,
            status: 'partial',
            filterKeys,
            ...(fullFailure ?? filtersItemError('WB_FULL_LISTS_INCOMPLETE', 'Wildberries did not return every full value list for this phrase.')),
            filters,
        };
    }));
    // A partial phrase has data, so the job is ok, but only fully answered phrases make it done.
    const answered = phrases.filter(({ status }) => status === 'ok' || status === 'partial' || status === 'empty').length;
    const complete = phrases.every(({ status }) => status === 'ok' || status === 'empty');
    return {
        ok: answered > 0,
        status: complete ? 'done' : answered > 0 ? 'partial' : 'failed',
        complete,
        requestsMade,
        queries: phrases.map(({ filters: _filters, ...phrase }) => phrase),
        filters: mergeFilters(phrases.map(({ filters }) => filters ?? [])),
    };
};
const executeProductCardJob = async ({ authorizationId, job, requestWbFetch, writer }) => {
    const articles = normalizeProductArticles(job.articles);
    const units = articles.flatMap((article) => job.endpoints.map((endpoint) => ({
        nmId: article.nm,
        key: endpoint.key,
        url: fillTemplate(endpoint.url, article),
    })));
    const fetched = await runWithConcurrency(units, PRODUCT_CARD_CONCURRENCY, countRunProgress(units.length, async (unit) => {
        try {
            const response = await requestWbFetch(unit.url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, response, ...buyerResponseErrorFields(response) });
            return { ...unit, response, ...buyerResponseErrorFields(response), ok: isSuccessfulWbResponse(response) };
        }
        catch (error) {
            rethrowAuthorizationError(error);
            await writer.append({
                jobId: job.jobId,
                ...unit,
                ...buyerErrorFields(error),
            });
            return { ...unit, ok: false, ...buyerErrorFields(error) };
        }
    }));
    const products = articles.map((article) => {
        const articleUnits = fetched.filter((unit) => unit.nmId === article.nm);
        const detailUnit = articleUnits.find((unit) => unit.key === 'detail') || articleUnits.find((unit) => responseProducts(unit.response).length);
        const cardUnit = articleUnits.find((unit) => unit.key === 'card');
        const detail = detailUnit ? summarizeProduct(article.nm, detailUnit.response) : { nmId: article.nm, ok: false };
        const content = compactCardBody(cardUnit?.response?.data?.body);
        return {
            ...detail,
            complete: detail.ok && articleUnits.every((unit) => unit.ok),
            ...content,
            nmId: article.nm,
            content,
            units: articleUnits.map((unit) => ({
                key: unit.key,
                ...(unit.errorDetails ? { errorDetails: unit.errorDetails } : {}),
                ...(unit.skipped ? { skipped: true } : {}),
                ok: unit.ok,
                httpStatus: unit.response?.data?.status,
                error: unit.error || unit.response?.error || unit.response?.data?.statusText,
            })),
        };
    });
    const succeeded = products.filter((product) => product.ok).length;
    return {
        ok: succeeded > 0,
        status: succeeded > 0 && products.some((product) => !product.complete) ? 'partial' : normalizeStatus(succeeded, products.length),
        total: products.length,
        succeeded,
        failed: products.length - succeeded,
        products,
    };
};
const normalizeRecommendationArticles = (articles) => articles.map(([nmId, pages]) => ({ nmId, pages }));
const executeRecommendationsJob = async ({ authorizationId, job, requestWbFetch, writer, projection }) => {
    const articles = normalizeRecommendationArticles(job.articles);
    const fetchPage = async (unit) => {
        const url = buildDescriptorUrl(job.endpoint, job.params, String(unit.nmId), unit.page);
        try {
            const response = await requestWbFetch(url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, url, response, ...buyerResponseErrorFields(response) });
            return {
                ...unit,
                url,
                response,
                ...buyerResponseErrorFields(response),
                ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
            };
        }
        catch (error) {
            rethrowAuthorizationError(error);
            await writer.append({
                jobId: job.jobId,
                ...unit,
                url,
                ...buyerErrorFields(error),
            });
            return { ...unit, url, ok: false, ...buyerErrorFields(error) };
        }
    };
    const firstPages = await runWithConcurrency(articles.map((article) => ({ ...article, page: 1 })), RECOMMENDATION_CONCURRENCY, fetchPage);
    const remainingUnits = [];
    const autoDepthCapped = new Set();
    for (const firstPage of firstPages) {
        const discoveredPages = recommendationTotalPages(numberOrUndefined(firstPage.response?.data?.body?.total));
        // Every first page belongs to one of the job's articles.
        const article = articles.find((item) => item.nmId === firstPage.nmId);
        if (article.pages === undefined && discoveredPages !== null && discoveredPages > MAX_RECOMMENDATION_PAGES_PER_PRODUCT) {
            autoDepthCapped.add(article.nmId);
        }
        const requestedPages = article.pages === undefined
            ? Math.min(discoveredPages || 1, MAX_RECOMMENDATION_PAGES_PER_PRODUCT)
            : Math.min(article.pages, discoveredPages || article.pages);
        const additionalPages = Math.max(0, requestedPages - 1);
        for (let page = 2; page <= additionalPages + 1; page += 1) {
            remainingUnits.push({ ...article, page });
        }
    }
    const remainingPages = await runWithConcurrency(remainingUnits, RECOMMENDATION_CONCURRENCY, fetchPage);
    const fetched = [...firstPages, ...remainingPages];
    const summaries = articles.map((article) => {
        let globalOffset = 0;
        let returnedProducts = 0;
        let globalPositionsReliable = true;
        const articleUnits = fetched.filter((unit) => unit.nmId === article.nmId).sort((left, right) => left.page - right.page);
        const overallTotal = numberOrUndefined(articleUnits[0]?.response?.data?.body?.total);
        const discoveredPages = recommendationTotalPages(overallTotal);
        const pages = articleUnits.map((unit) => {
            const products = responseProducts(unit.response);
            const productLimit = projection.productNmIds ? MAX_RETURNED_PRODUCTS : projection.productLimitPerScope;
            const remaining = Math.max(0, productLimit - returnedProducts);
            const pageGlobalPositionsReliable = globalPositionsReliable && unit.ok;
            const selected = unit.ok
                ? projectPageProducts(products, globalOffset, projection.productNmIds, remaining, pageGlobalPositionsReliable)
                : [];
            returnedProducts += selected.length;
            const page = {
                page: unit.page,
                ok: unit.ok,
                httpStatus: unit.response?.data?.status,
                total: products.length,
                globalPositionsReliable: pageGlobalPositionsReliable,
                products: selected,
            };
            if (!unit.ok) {
                Object.assign(page, unit.errorDetails ? { errorDetails: unit.errorDetails } : {}, unit.skipped ? { skipped: true } : {});
                page.error = unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB recommendation request failed';
            }
            if (!unit.ok)
                globalPositionsReliable = false;
            globalOffset += products.length;
            return page;
        });
        return {
            sourceNmId: article.nmId,
            pagesRequested: pages.length,
            pagesSucceeded: pages.filter((page) => page.ok).length,
            overallTotal,
            totalPages: discoveredPages,
            productsSeen: pages.reduce((total, page) => total + page.total, 0),
            productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
            truncatedByLocalLimit: autoDepthCapped.has(article.nmId),
            globalPositionsComplete: pages.every((page) => page.globalPositionsReliable),
            pages,
        };
    });
    const succeeded = fetched.filter((unit) => unit.ok).length;
    const truncatedByLocalLimit = autoDepthCapped.size > 0;
    return {
        ok: succeeded > 0,
        status: truncatedByLocalLimit && succeeded === fetched.length ? 'partial' : normalizeStatus(succeeded, fetched.length),
        complete: !truncatedByLocalLimit && succeeded === fetched.length,
        truncatedByLocalLimit,
        pagesRequested: fetched.length,
        pagesSucceeded: succeeded,
        pagesFailed: fetched.length - succeeded,
        productFilterApplied: Boolean(projection.productNmIds),
        productLimitPerSource: projection.productNmIds ? undefined : projection.productLimitPerScope,
        articles: summaries,
    };
};
export const executeAuthorizedBrowserJob = async ({ authorization, requestWbFetch, writer, productLimitPerScope = DEFAULT_RETURNED_PRODUCTS, productNmIds, }) => {
    validateAuthorizedJobLimits(authorization);
    const originalFetch = requestWbFetch;
    let rateLimited = false;
    let answered = 0;
    requestWbFetch = async (...args) => {
        if (rateLimited) {
            const error = new ToolExecutionError('WB_RATE_LIMITED', 'Not requested because Wildberries rate limited this job.', 'execution', false);
            skippedBuyerErrors.add(error);
            throw error;
        }
        const response = await originalFetch(...args);
        answered += 1;
        // Observe before writer I/O; in-flight requests may finish, but no new request is sent.
        if (response?.data?.status === 429)
            rateLimited = true;
        return response;
    };
    const projection = { productLimitPerScope, productNmIds };
    let result;
    try {
        result = await executeWbJob(authorization, requestWbFetch, writer, projection);
    }
    catch (error) {
        if (!(error instanceof ToolExecutionError))
            throw error;
        throw stoppedWbJobError(error, authorization, answered);
    }
    return {
        ...result,
        ...(rateLimited ? { stopReason: 'rate_limited' } : {}),
        jobType: authorization.jobType,
        jobId: authorization.job.jobId,
        expiresAt: authorization.expiresAt,
    };
};
// Parse boundary: the checked grant; its job is the descriptor of its job type.
const executeWbJob = async (authorization, requestWbFetch, writer, projection) => {
    let result;
    if (authorization.jobType === 'search_by_query') {
        result = await executeSearchJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
            projection,
        });
    }
    else if (authorization.jobType === 'check_by_query') {
        result = await executeCheckByQueryJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
        });
    }
    else if (authorization.jobType === 'filters_by_query') {
        result = await executeFiltersByQueryJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
        });
    }
    else if (authorization.jobType === 'product_card') {
        result = await executeProductCardJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
        });
    }
    else if (authorization.jobType === 'recommendations_by_product') {
        result = await executeRecommendationsJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
            projection,
        });
    }
    else {
        throw new Error(`Unsupported browser_job type: ${authorization.jobType}`);
    }
    return result;
};
