export const createConcurrencyLimiter = (concurrency, worker) => {
    let active = 0;
    const queued = [];
    const acquire = () => {
        if (active < concurrency) {
            active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => queued.push(resolve));
    };
    const release = () => {
        const next = queued.shift();
        if (next)
            next();
        else
            active -= 1;
    };
    return async (...args) => {
        await acquire();
        try {
            return await worker(...args);
        }
        finally {
            release();
        }
    };
};
export const runWithConcurrency = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
};
