/**
 * CCGram Logger
 * Centralized logging utility
 */

class Logger {
    constructor(namespace = 'CCGram') {
        this.namespace = namespace;
    }

    get logLevel() {
        return process.env.LOG_LEVEL || 'info';
    }

    _log(level, message, ...args) {
        if (!this._shouldLog(level)) return;
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${this.namespace}] [${level.toUpperCase()}]`;
        if (level === 'error') console.error(prefix, message, ...args);
        else if (level === 'warn') console.warn(prefix, message, ...args);
        else console.log(prefix, message, ...args);
    }

    _shouldLog(level) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        return levels[level] >= levels[this.logLevel];
    }

    debug(message, ...args) {
        this._log('debug', message, ...args);
    }

    info(message, ...args) {
        this._log('info', message, ...args);
    }

    warn(message, ...args) {
        this._log('warn', message, ...args);
    }

    error(message, ...args) {
        this._log('error', message, ...args);
    }

    child(namespace) {
        return new Logger(`${this.namespace}:${namespace}`);
    }
}

module.exports = Logger;