// Parse boundary: WB answers and their products are read field by field.
export const responseProducts = (response) => (Array.isArray(response?.data?.body?.products) ? response.data.body.products : []);
export const numberOrUndefined = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const positiveSafeIntegerOrUndefined = (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const toRub = (value) => (numberOrUndefined(value) === undefined ? undefined : Math.round(value) / 100);
const summarizeListingProduct = (product, position, globalPosition) => {
    const nmId = positiveSafeIntegerOrUndefined(product?.id);
    if (nmId === undefined)
        return undefined;
    const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
    const price = sizes.find((size) => size?.price)?.price || product?.price;
    const row = {
        nmId,
        name: typeof product?.name === 'string' ? product.name : undefined,
        brand: typeof product?.brand === 'string' ? product.brand : undefined,
        supplierId: numberOrUndefined(product?.supplierId),
        priceRub: price ? { basic: toRub(price.basic), product: toRub(price.product) } : undefined,
        rating: numberOrUndefined(product?.reviewRating),
        feedbacks: numberOrUndefined(product?.feedbacks),
        pics: numberOrUndefined(product?.pics),
        promoted: isPromotedViewFlags(product?.viewFlags),
        position,
    };
    if (globalPosition !== undefined && Number.isSafeInteger(globalPosition) && globalPosition > 0) {
        row.globalPosition = globalPosition;
    }
    return row;
};
const isPromotedViewFlags = (value) => {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 && (BigInt(value) & 64n) !== 0n;
    }
    return typeof value === 'string' && /^\d{1,20}$/.test(value) && (BigInt(value) & 64n) !== 0n;
};
export const projectPageProducts = (products, globalOffset, productNmIds, remainingLimit, includeGlobalPosition = true) => {
    const filter = productNmIds ? new Set(productNmIds) : null;
    const rows = products
        .map((product, index) => summarizeListingProduct(product, index + 1, includeGlobalPosition ? globalOffset + index + 1 : undefined))
        .filter((row) => Boolean(row));
    const selected = (filter ? rows.filter((row) => filter.has(row.nmId)) : rows).slice(0, remainingLimit);
    return selected;
};
export const summarizeProduct = (nmId, response) => {
    const product = Array.isArray(response?.data?.body?.products) ? response.data.body.products[0] : undefined;
    if (!product || typeof product !== 'object') {
        return {
            nmId,
            ok: false,
            status: response?.data?.status,
            error: response?.error || 'WB response did not contain a product',
        };
    }
    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    const warehouseNames = response?.warehouseNames && typeof response.warehouseNames === 'object' && !Array.isArray(response.warehouseNames)
        ? response.warehouseNames
        : {};
    const byWarehouseMap = new Map();
    const bySize = [];
    let quantityTotal = 0;
    for (const size of sizes) {
        const stocks = Array.isArray(size?.stocks) ? size.stocks : [];
        const warehouses = new Set();
        let sizeQuantity = 0;
        for (const stock of stocks) {
            const wh = numberOrUndefined(stock?.wh);
            if (wh === undefined)
                continue;
            const qty = numberOrUndefined(stock?.qty) || 0;
            quantityTotal += qty;
            sizeQuantity += qty;
            warehouses.add(wh);
            const current = byWarehouseMap.get(wh) || { wh, qty: 0, rows: 0 };
            const warehouseName = typeof warehouseNames[String(wh)] === 'string' ? warehouseNames[String(wh)].trim() : '';
            if (warehouseName && !current.warehouse) {
                current.warehouse = warehouseName;
            }
            current.qty += qty;
            current.rows += 1;
            byWarehouseMap.set(wh, current);
        }
        bySize.push({
            size: typeof size?.origName === 'string' ? size.origName : typeof size?.name === 'string' ? size.name : '',
            qty: sizeQuantity,
            warehouses: warehouses.size,
        });
    }
    const price = sizes.find((size) => size?.price)?.price || product.price;
    return {
        nmId: positiveSafeIntegerOrUndefined(product.id) ?? nmId,
        ok: true,
        name: typeof product.name === 'string' ? product.name : undefined,
        brand: typeof product.brand === 'string' ? product.brand : undefined,
        supplier: typeof product.supplier === 'string' ? product.supplier : undefined,
        supplierId: numberOrUndefined(product.supplierId),
        rating: numberOrUndefined(product.reviewRating),
        feedbacks: numberOrUndefined(product.feedbacks),
        pics: numberOrUndefined(product.pics),
        priceRub: {
            basic: toRub(price?.basic),
            product: toRub(price?.product),
            logistics: toRub(price?.logistics),
            return: toRub(price?.return),
            cashback: toRub(price?.cashback),
        },
        quantity: {
            total: quantityTotal,
            byWarehouse: [...byWarehouseMap.values()],
            bySize,
        },
        status: response?.data?.status,
    };
};
