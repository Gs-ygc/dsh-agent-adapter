export interface AgentDetection {
    detected: boolean;
    /** First line of `--version` output when the probe produced one. */
    version?: string;
}
/** Probe one command with `--version`; PATH misses and timeouts read as absent. */
export declare function detectAgent(command: string): Promise<AgentDetection>;
