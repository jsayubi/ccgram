/**
 * Safely require an optional dependency.
 * Returns the module if available, or null if not installed.
 * Logs an actionable install message on failure.
 */
function optionalRequire(moduleName, featureName) {
    try {
        return require(moduleName);
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            console.warn(
                `[ccgram] Optional dependency "${moduleName}" not installed. ` +
                `Feature "${featureName}" will be unavailable. ` +
                `Install with: npm install ${moduleName}`
            );
            return null;
        }
        throw err;
    }
}

/**
 * Get a uuid.v4-compatible function using Node's built-in crypto module.
 * Returns a RFC 4122 v4 UUID generator (no external dependency needed).
 */
function getUUID() {
    return function uuidv4() {
        const bytes = require('crypto').randomBytes(16);
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
        const hex = bytes.toString('hex');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    };
}

module.exports = optionalRequire;
module.exports.optionalRequire = optionalRequire;
module.exports.getUUID = getUUID;
