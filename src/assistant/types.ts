// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The contract between the conversation loop and a model provider.
 *
 * Types only, on purpose: the Claude provider is a lazily loaded chunk, and a chunk that
 * imports a runtime value from a module the entry also uses would import it back from
 * the entry asset and boot a second App (see src/ui/NOTES.md, commit 0340d7a). Type
 * imports are erased, so providers may use everything here.
 */

/** A tool as the model sees it: name, prose and a JSON Schema for its input. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed input, or the raw text when it was not valid JSON. */
  input: unknown;
  /** The input could not be parsed as JSON at all. */
  invalidJson?: boolean;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

/** Why a model turn ended, normalised across providers. */
export type StopKind = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

export interface TurnResult {
  stop: StopKind;
  toolCalls: ToolCall[];
  /** Plain text the model produced this turn. */
  text: string;
  /** Provider-specific detail for a refusal or an unusual stop. */
  detail?: string;
}

export interface TurnHandlers {
  onText(delta: string): void;
  onThinking(delta: string): void;
}

export type ProviderErrorKind = 'auth' | 'rate' | 'network' | 'invalid' | 'server' | 'aborted' | 'other';

export interface ProviderError {
  kind: ProviderErrorKind;
  status?: number;
  message: string;
}

/**
 * One conversation with one provider. The provider owns its native transcript (Claude
 * content blocks, OpenAI chat messages) and only ever appends to it - Claude Opus 5.5
 * binds its thinking blocks to the exact history that produced them.
 */
export interface Provider {
  addUserText(text: string): void;
  /** Run one model turn; append the assistant message to the transcript on success. */
  runTurn(handlers: TurnHandlers, signal: AbortSignal): Promise<TurnResult>;
  /** Answer every tool call of the last turn, in one message. */
  addToolResults(results: ToolResult[]): void;
  /** Map a thrown value to something the UI can explain. */
  describeError(e: unknown): ProviderError;
}

export interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** The official endpoint (server-side features a relay may reject are enabled only then). */
  official: boolean;
  system: string;
  tools: ToolSpec[];
}
