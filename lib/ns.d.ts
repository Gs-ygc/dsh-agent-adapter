/** The unified settings namespace owned by the combined plugin entry. */
export declare const AGENT_ADAPTER_NS: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/**
 * The hooks a half exposes so the combined entry can wire it into the single
 * settings section (mirrors {@link installSettingsSection}'s consumer hooks).
 */
export interface SettingsHooks<T> {
    /** Point the half at a new resolved-config source thunk. */
    setSource: (source: () => T) => void;
    /** Notify the half that its resolved slice may have changed. */
    onChange: () => void;
}
