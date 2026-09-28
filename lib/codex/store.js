/**
 * Durable DSH↔codex thread mapping. One JSON document, written atomically
 * (tmp + rename) on every mutation; corruption falls back to empty so a bad
 * file never blocks session creation — affected sessions just re-establish.
 *
 * @module dsh-agent-adapter/codex/store
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export class CodexSessionStore {
    file;
    logger;
    data = {};
    loaded = false;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger;
    }
    ensureLoaded() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                this.data = parsed;
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger(`codex: ignoring unreadable session store ${this.file}: ${error}`);
            }
        }
    }
    persist() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            renameSync(tmp, this.file);
        }
        catch (error) {
            this.logger(`codex: failed to persist session store ${this.file}: ${error}`);
        }
    }
    get(route, dshSessionId) {
        this.ensureLoaded();
        return this.data[route]?.[dshSessionId];
    }
    set(route, dshSessionId, session) {
        this.ensureLoaded();
        (this.data[route] ??= {})[dshSessionId] = session;
        this.persist();
    }
    /** Forget every stored session of one route (profile removed). */
    deleteRoute(route) {
        this.ensureLoaded();
        if (delete this.data[route])
            this.persist();
    }
    /** Forget one stored session mapping (engine side is the caller's job). */
    deleteSession(route, dshSessionId) {
        this.ensureLoaded();
        const routeData = this.data[route];
        if (routeData !== undefined && delete routeData[dshSessionId]) {
            this.persist();
            return true;
        }
        return false;
    }
    /** All stored session ids of one route (reconciliation callers scan these). */
    sessionIds(route) {
        this.ensureLoaded();
        return Object.keys(this.data[route] ?? {});
    }
}
