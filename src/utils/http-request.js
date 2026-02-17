/**
 * Lightweight HTTP/JSON helper using Node's built-in https module.
 * Replaces axios for simple GET/POST JSON requests.
 *
 * Supports: IPv4 forcing (family: 4), custom headers, timeout.
 */

const https = require('https');
const { URL } = require('url');

/**
 * Make an HTTPS JSON request.
 * @param {string} method - 'GET' or 'POST'
 * @param {string} url - Full URL (https://...)
 * @param {Object|null} body - JSON body for POST requests
 * @param {Object} [opts] - Options: { headers, family, timeout }
 * @returns {Promise<{ status: number, data: any }>}
 */
function httpJSON(method, url, body, opts = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const payload = body ? JSON.stringify(body) : null;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method,
            headers: { ...opts.headers },
            timeout: opts.timeout || 10000,
        };

        if (opts.family) {
            options.family = opts.family;
        }

        if (payload) {
            options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = data;
                }
                resolve({ status: res.statusCode, data: parsed });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

/** Convenience: GET request */
httpJSON.get = (url, opts) => httpJSON('GET', url, null, opts);

/** Convenience: POST request */
httpJSON.post = (url, body, opts) => httpJSON('POST', url, body, opts);

module.exports = httpJSON;
