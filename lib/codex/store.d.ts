/** Persisted state for one DSH session's codex counterpart. */
export interface StoredCodexSession {
    /** codex thread id returned by `thread/start`. */
    threadId: string;
    /** Working directory the thread was created with. */
    cwd: string;
    /** codex model id currently selected on the thread, when known. */
    model?: string;
    /** Text fingerprints of user turns already delivered to codex, in order. */
    sentUserTurns: string[];
    /** Context size learned from `thread/tokenUsage/updated`, when seen. */
    contextWindow?: number;
}
export declare class CodexSessionStore {
    readonly file: string;
    private readonly logger;
    private data;
    private loaded;
    constructor(file: string, logger: (message: string) => void);
    private ensureLoaded;
    private persist;
    get(route: string, dshSessionId: string): StoredCodexSession | undefined;
    set(route: string, dshSessionId: string, session: StoredCodexSession): void;
    /** Forget every stored session of one route (profile removed). */
    deleteRoute(route: string): void;
}
