// CalVer as the plugin's update notice and DeepSeek's updater read it, so both hosts agree on "newer". The update hook
// keeps its own copy, because a host may copy only hooks/; tests/contexts/plugin-update pins the two equal.
const CALVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+codex\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const MAX_CALVER_BYTES = 256;
/** The numeric components of a CalVer, ignoring `+codex` build metadata, or null for anything else. */
export const normalizeCalVer = (value) => {
    if (typeof value !== 'string')
        return null;
    if (Buffer.byteLength(value, 'utf8') > MAX_CALVER_BYTES)
        return null;
    const match = CALVER_PATTERN.exec(value);
    if (match === null)
        return null;
    const components = match.slice(1, 4).map(Number);
    return components.every(Number.isSafeInteger) ? components : null;
};
/** -1, 0 or 1 by numeric components, or null when either side is not a CalVer. */
export const compareCalVer = (left, right) => {
    const normalizedLeft = normalizeCalVer(left);
    const normalizedRight = normalizeCalVer(right);
    if (normalizedLeft === null || normalizedRight === null)
        return null;
    for (let index = 0; index < normalizedLeft.length; index += 1) {
        const leftComponent = normalizedLeft[index];
        const rightComponent = normalizedRight[index];
        if (leftComponent < rightComponent)
            return -1;
        if (leftComponent > rightComponent)
            return 1;
    }
    return 0;
};
