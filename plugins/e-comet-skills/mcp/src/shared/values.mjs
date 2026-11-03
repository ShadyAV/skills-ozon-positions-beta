// Value checks several modules share (refactor spec §6.3).
// A version-4 UUID as e-Comet generates it, in lower-case hex: artifact, result and report ids.
export const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// A canonical 24-character UTC timestamp, the only time form every report consumer accepts.
export const isCanonicalTimestamp = (value) => {
    if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
        return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
};
