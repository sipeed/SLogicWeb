// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The conversation loop: model turn -> tool calls -> results -> next turn, until the
 * model answers without calling a tool.
 *
 * Written by hand rather than with the SDK's tool runner because it has to serve two
 * wire protocols and stop for the user's approval before any tool that changes the
 * capture. Invariants the providers rely on:
 *   - every tool call of a turn gets exactly one result, sent together in one message,
 *     even when the user declines, the input is invalid or the run is aborted -
 *     otherwise the next request is rejected for an unanswered tool call;
 *   - a turn's tools never run when it stopped for a refusal or hit max_tokens: a
 *     truncated input can still look valid.
 */

import { TOOLS, toolByName, validate, type AssistantHost, type AssistantTool, type ToolRisk } from './tools.js';
import type { Provider, ProviderError, ToolCall, ToolResult } from './types.js';

/** Characters of tool output handed back to the model per call. */
export const RESULT_MAX_CHARS = 24_000;
export const MAX_TURNS = 24;

export type StopReason = 'end' | 'max_tokens' | 'refusal' | 'aborted' | 'max_turns' | 'other';

export type LoopEvent =
  | { type: 'turn' }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool-call'; call: ToolCall; risk: ToolRisk | null }
  | { type: 'tool-result'; id: string; content: string; isError: boolean; declined: boolean }
  | { type: 'stopped'; reason: StopReason; detail?: string }
  | { type: 'error'; error: ProviderError };

/** Ask the user whether an `act` tool may run. Resolves false when declined or aborted. */
export type Approver = (call: ToolCall, tool: AssistantTool, signal: AbortSignal) => Promise<boolean>;

export class Conversation {
  constructor(
    private readonly provider: Provider,
    private readonly host: AssistantHost,
    private readonly approve: Approver,
    private readonly emit: (e: LoopEvent) => void,
    private readonly maxTurns = MAX_TURNS,
  ) {}

  /** One user message, run to the model's final answer. Never throws. */
  async send(text: string, signal: AbortSignal): Promise<void> {
    this.provider.addUserText(text);
    for (let turn = 0; turn < this.maxTurns; turn++) {
      this.emit({ type: 'turn' });
      let result;
      try {
        result = await this.provider.runTurn({
          onText: (delta) => this.emit({ type: 'text', delta }),
          onThinking: (delta) => this.emit({ type: 'thinking', delta }),
        }, signal);
      } catch (e) {
        if (signal.aborted) { this.emit({ type: 'stopped', reason: 'aborted' }); return; }
        this.emit({ type: 'error', error: this.provider.describeError(e) });
        return;
      }
      if (result.stop === 'refusal') {
        this.emit({ type: 'stopped', reason: 'refusal', ...(result.detail ? { detail: result.detail } : {}) });
        return;
      }
      if (result.stop === 'max_tokens') {
        this.emit({ type: 'stopped', reason: 'max_tokens' });
        return;
      }
      if (result.stop === 'pause') continue;
      if (result.toolCalls.length === 0) {
        this.emit({ type: 'stopped', reason: result.stop === 'end' ? 'end' : 'other', ...(result.detail ? { detail: result.detail } : {}) });
        return;
      }
      const results: ToolResult[] = [];
      for (const call of result.toolCalls) results.push(await this.runCall(call, signal));
      this.provider.addToolResults(results);
      if (signal.aborted) { this.emit({ type: 'stopped', reason: 'aborted' }); return; }
    }
    this.emit({ type: 'stopped', reason: 'max_turns' });
  }

  private async runCall(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const tool = toolByName(call.name);
    this.emit({ type: 'tool-call', call, risk: tool?.risk ?? null });
    const done = (content: string, isError: boolean, declined = false): ToolResult => {
      const clipped = content.length > RESULT_MAX_CHARS
        ? `${content.slice(0, RESULT_MAX_CHARS)}… [truncated ${content.length - RESULT_MAX_CHARS} characters]`
        : content;
      this.emit({ type: 'tool-result', id: call.id, content: clipped, isError, declined });
      return { id: call.id, content: clipped, isError };
    };
    if (signal.aborted) return done('Cancelled by the user.', true);
    if (!tool) return done(`Unknown tool "${call.name}". Available: ${TOOLS.map((t) => t.name).join(', ')}.`, true);
    if (call.invalidJson) {
      return done(`INVALID_JSON: the tool input was not valid JSON: ${String(call.input).slice(0, 500)}`, true);
    }
    const problems = validate(call.input, tool.inputSchema);
    if (problems.length) return done(`Invalid input: ${problems.join('; ')}.`, true);
    if (tool.risk === 'act' && !(await this.approve(call, tool, signal))) {
      return signal.aborted
        ? done('Cancelled by the user.', true)
        : done('The user declined this action.', true, true);
    }
    try {
      const out = await tool.run(call.input as Record<string, unknown>, this.host, signal);
      return done(JSON.stringify(out), false);
    } catch (e) {
      return done(e instanceof Error ? e.message : String(e), true);
    }
  }
}
