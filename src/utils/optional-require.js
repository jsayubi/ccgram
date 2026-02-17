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
 * Get a uuid.v4-compatible function, falling back to crypto-based implementation.
 * Caches the result to avoid repeated warnings.
 */
let _uuidv4;
function getUUID() {
    if (_uuidv4) return _uuidv4;

    const uuidModule = optionalRequire('uuid', 'UUID generation');
    if (uuidModule) {
        _uuidv4 = uuidModule.v4;
    } else {
        _uuidv4 = function uuidv4() {
            const bytes = require('crypto').randomBytes(16);
            bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
            bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
            const hex = bytes.toString('hex');
            return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
        };
    }
    return _uuidv4;
}

module.exports = optionalRequire;
module.exports.optionalRequire = optionalRequire;
module.exports.getUUID = getUUID;
