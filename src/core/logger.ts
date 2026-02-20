/**
 * CCGram Logger
 * Centralized logging utility
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
    namespace: string;

    constructor(namespace: string = 'CCGram') {
        this.namespace = namespace;
    }

    get logLevel(): LogLevel {
        return (process.env.LOG_LEVEL as LogLevel) || 'info';
    }

    _log(level: LogLevel, message: string, ...args: unknown[]): void {
        if (!this._shouldLog(level)) return;
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${this.namespace}] [${level.toUpperCase()}]`;
        if (level === 'error') console.error(prefix, message, ...args);
        else if (level === 'warn') console.warn(prefix, message, ...args);
        else console.log(prefix, message, ...args);
    }

    _shouldLog(level: LogLevel): boolean {
        const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
        return levels[level] >= levels[this.logLevel];
    }

    debug(message: string, ...args: unknown[]): void {
        this._log('debug', message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        this._log('info', message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this._log('warn', message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        this._log('error', message, ...args);
    }

    child(namespace: string): Logger {
        return new Logger(`${this.namespace}:${namespace}`);
    }
}

export = Logger;
