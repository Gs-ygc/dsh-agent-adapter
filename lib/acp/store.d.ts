/** Persisted state for one DSH session's ACP counterpart. */
export interface StoredAcpSession {
    /** ACP-side session id returned by `session/new`. */
    acpSessionId: string;
    /** Working directory the ACP session was created with (required by `session/load`). */
    cwd: string;
    /** ACP model id currently selected on the session, when known. */
    model?: string;
    /** Reasoning effort currently selected on the session, when the model exposes one. */
    effort?: string;
    /** Text fingerprints of user turns already delivered to the agent, in order. */
    sentUserTurns: string[];
    /** Context size learned from `usage_update` notifications, when seen. */
    contextWindow?: number;
}
export declare class AcpSessionStore {
    readonly file: string;
    private readonly logger;
    private data;
    private loaded;
    constructor(file: string, logger: (message: string) => void);
    private ensureLoaded;
    private persist;
    get(route: string, dshSessionId: string): StoredAcpSession | undefined;
    set(route: string, dshSessionId: string, session: StoredAcpSession): void;
    /** Forget every stored session of one route (profile removed). */
    deleteRoute(route: string): void;
}
