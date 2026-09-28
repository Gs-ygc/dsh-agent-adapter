/**
 * dsh-agent-adapter: merged host-plane plugin bundling the two external-agent
 * adapters for the DeepSeek Harness LLM seam:
 *
 * - codex half (`./codex`): serves routes backed by `codex app-server`
 *   processes, settings slice `agent-adapter.codex`, state in
 *   `$DSH_HOME/llm-codex/sessions.json`.
 * - ACP half (`./acp`): serves routes backed by ACP agent processes (opencode,
 *   kimi, pi, …), settings slice `agent-adapter.acp`, state in
 *   `$DSH_HOME/llm-acp/sessions.json`, plus the client settings page served
 *   from `/plugins/dsh-agent-adapter/client.js` with its state endpoint at
 *   `/plugins/dsh-agent-adapter/state.json`.
 *
 * Both halves share the single `agent-adapter` settings namespace
 * (this module's Config is its schema; the halves expose hooks instead of
 * self-registering). State files are unchanged. Each half mounts dormant
 * until its settings slice supplies provider profiles (or its known-agent
 * scan detects an installed agent); settings changes hot-swap the registered
 * route set. The single settings page («Agent 适配 / Agent Adapter») covers
 * both halves: the ACP half owns the web state endpoint and folds in the codex
 * half's known-agent row via a state contribution.
 *
 * @module dsh-agent-adapter
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { Config as CodexConfig, CodexAdapter, applyCodex, type RawConfig as CodexRawConfig } from './codex/index.js';
import { Config as AcpConfig, AcpAdapter, applyAcp, type RawConfig as AcpRawConfig } from './acp/index.js';
declare const name = "agent-adapter";
declare const inject: string[];
/**
 * Combined runtime schema — also the schema of the single `agent-adapter`
 * settings namespace. The two halves keep independent slices (`codex:` /
 * `acp:`); plugin-level keys simply seed each half's base config.
 */
export declare const Config: z<Schemastery.ObjectS<{
    codex: z<Schemastery.ObjectS<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            approvalPolicy?: string | null | undefined;
            sandbox?: string | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            approvalPolicy: z<string, string>;
            sandbox: z<string, string>;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>, Schemastery.ObjectT<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            approvalPolicy?: string | null | undefined;
            sandbox?: string | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            approvalPolicy: z<string, string>;
            sandbox: z<string, string>;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>>;
    acp: z<Schemastery.ObjectS<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>, Schemastery.ObjectT<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>>;
}>, Schemastery.ObjectT<{
    codex: z<Schemastery.ObjectS<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            approvalPolicy?: string | null | undefined;
            sandbox?: string | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            approvalPolicy: z<string, string>;
            sandbox: z<string, string>;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>, Schemastery.ObjectT<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            approvalPolicy?: string | null | undefined;
            sandbox?: string | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            approvalPolicy: z<string, string>;
            sandbox: z<string, string>;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>>;
    acp: z<Schemastery.ObjectS<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>, Schemastery.ObjectT<{
        providers: z<import("@deepseek-ai/cosmokit").Dict<{
            displayName?: string | null | undefined;
            command?: string | null | undefined;
            args?: string[] | null | undefined;
            env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
            cwd?: string | null | undefined;
            permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
            defaultContextWindow?: number | null | undefined;
            defaultMaxTokens?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            displayName: z<string, string>;
            command: z<string, string>;
            args: z<string[], string[]>;
            env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
            cwd: z<string, string>;
            permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
            defaultContextWindow: z<number, number>;
            defaultMaxTokens: z<number, number>;
        }>, string>>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<{
            enabled?: boolean | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
        }>, string>>;
    }>>;
}>>;
/** Loose plugin config accepted by apply; each half validates its own slice. */
export interface AgentAdapterConfig {
    codex?: CodexRawConfig;
    acp?: AcpRawConfig;
}
export declare function apply(ctx: Context, config: AgentAdapterConfig): void;
export { CodexConfig, AcpConfig, CodexAdapter, AcpAdapter, applyCodex, applyAcp, inject, name };
export { AGENT_ADAPTER_NS } from './ns.js';
declare const _default: {
    name: string;
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        codex: z<Schemastery.ObjectS<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                approvalPolicy?: string | null | undefined;
                sandbox?: string | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                approvalPolicy: z<string, string>;
                sandbox: z<string, string>;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>, Schemastery.ObjectT<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                approvalPolicy?: string | null | undefined;
                sandbox?: string | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                approvalPolicy: z<string, string>;
                sandbox: z<string, string>;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>>;
        acp: z<Schemastery.ObjectS<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>, Schemastery.ObjectT<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>>;
    }>, Schemastery.ObjectT<{
        codex: z<Schemastery.ObjectS<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                approvalPolicy?: string | null | undefined;
                sandbox?: string | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                approvalPolicy: z<string, string>;
                sandbox: z<string, string>;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>, Schemastery.ObjectT<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                approvalPolicy?: string | null | undefined;
                sandbox?: string | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                approvalPolicy: z<string, string>;
                sandbox: z<string, string>;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>>;
        acp: z<Schemastery.ObjectS<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>, Schemastery.ObjectT<{
            providers: z<import("@deepseek-ai/cosmokit").Dict<{
                displayName?: string | null | undefined;
                command?: string | null | undefined;
                args?: string[] | null | undefined;
                env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
                cwd?: string | null | undefined;
                permissionPolicy?: "allow" | "deny" | "auto" | null | undefined;
                defaultContextWindow?: number | null | undefined;
                defaultMaxTokens?: number | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                displayName: z<string, string>;
                command: z<string, string>;
                args: z<string[], string[]>;
                env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
                cwd: z<string, string>;
                permissionPolicy: z<"allow" | "deny" | "auto", "allow" | "deny" | "auto">;
                defaultContextWindow: z<number, number>;
                defaultMaxTokens: z<number, number>;
            }>, string>>;
            agents: z<import("@deepseek-ai/cosmokit").Dict<{
                enabled?: boolean | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
                enabled: z<boolean, boolean>;
            }>, string>>;
        }>>;
    }>>;
    apply: typeof apply;
};
export default _default;
