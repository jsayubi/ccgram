/**
 * Lightweight HTTP/JSON helper using Node's built-in https module.
 * Replaces axios for simple GET/POST JSON requests.
 *
 * Supports: IPv4 forcing (family: 4), custom headers, timeout.
 */

import https from 'https';
import { URL } from 'url';

interface HttpOptions {
  headers?: Record<string, string>;
  family?: 4 | 6;
  timeout?: number;
}

interface HttpResponse {
  status: number | undefined;
  data: unknown;
}

/**
 * Make an HTTPS JSON request.
 */
function httpJSON(method: string, url: string, body: unknown | null, opts: HttpOptions = {}): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const payload = body ? JSON.stringify(body) : null;

        const headers: Record<string, string | number> = { ...opts.headers };

        const options: https.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method,
            headers,
            timeout: opts.timeout || 10000,
        };

        if (opts.family) {
            options.family = opts.family;
        }

        if (payload) {
            headers['Content-Type'] = headers['Content-Type'] || 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                let parsedData: unknown;
                try {
                    parsedData = JSON.parse(data);
                } catch {
                    parsedData = data;
                }
                resolve({ status: res.statusCode, data: parsedData });
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
httpJSON.get = (url: string, opts?: HttpOptions): Promise<HttpResponse> => httpJSON('GET', url, null, opts);

/** Convenience: POST request */
httpJSON.post = (url: string, body: unknown, opts?: HttpOptions): Promise<HttpResponse> => httpJSON('POST', url, body, opts);

export = httpJSON;
