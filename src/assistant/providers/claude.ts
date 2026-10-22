// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Claude through the official SDK, straight from the browser with the user's own key.
 *
 * Loaded lazily (assistantPanel.ts imports it on first send) so pages that never open
 * the assistant do not download the SDK. That makes this file a separate chunk, and a
 * chunk must not import a runtime value from any module the entry also uses - it would
 * import it back from the entry asset and start a second App. Hence: the SDK is the only
 * runtime import here; everything from ../types is `import type`. tools/
 * assistant-selftest.ts checks the built chunk for exactly that.
 *
 * `dangerouslyAllowBrowser` is the SDK's opt-in for exactly this deployment: a static page
 * with no server, where the key belongs to the person at the keyboard and never leaves
 * their browser except to the endpoint they chose.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider, ProviderConfig, ProviderError, ToolCall, ToolResult, TurnHandlers, TurnResult,
} from '../types.js';

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** Consecutive re-issues of a turn whose tool input was not parseable JSON. */
const JSON_RETRIES = 2;

export function createClaudeProvider(cfg: ProviderConfig): Provider {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    dangerouslyAllowBrowser: true,
  });
  const tools: Anthropic.Beta.BetaTool[] = cfg.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    // Inputs stream as generated; loop.ts validates every one against its schema.
    eager_input_streaming: true,
  }));
  const messages: MessageParam[] = [];

  return {
    addUserText(text) {
      messages.push({ role: 'user', content: text });
    },

    async runTurn(h: TurnHandlers, signal: AbortSignal): Promise<TurnResult> {
      for (let attempt = 0; ; attempt++) {
        const stream = client.beta.messages.stream({
          model: cfg.model,
          max_tokens: 64000,
          system: cfg.system,
          tools,
          messages,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'medium' },
          // Caches system + tools + history; the system prompt is byte-stable on purpose.
          cache_control: { type: 'ephemeral' },
          // A safety decline is retried server-side on the model Anthropic recommends for
          // that category. Only on the official endpoint: relays tend to reject unknown
          // parameters and beta headers.
          ...(cfg.official ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        }, { signal });
        stream.on('text', (delta) => h.onText(delta));
        stream.on('thinking', (delta) => h.onThinking(delta));

        let msg: Anthropic.Beta.BetaMessage;
        try {
          msg = await stream.finalMessage();
        } catch (e) {
          // Only an unparseable tool input is retried - API errors (auth, rate limit,
          // network) and aborts go to the caller. The failed turn was never appended.
          if (e instanceof Anthropic.APIError || signal.aborted || attempt >= JSON_RETRIES) throw e;
          continue;
        }

        const toolCalls: ToolCall[] = msg.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const text = msg.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text).join('');

        if (msg.stop_reason === 'refusal') {
          // Discard the declined turn: never run its tools, never send it back.
          const d = msg.stop_details;
          return { stop: 'refusal', toolCalls: [], text, ...(d ? { detail: d.explanation ?? d.category ?? '' } : {}) };
        }
        if (msg.stop_reason === 'max_tokens' && toolCalls.length) {
          return { stop: 'max_tokens', toolCalls: [], text };
        }
        // Append the whole content - thinking and fallback blocks included, unchanged.
        messages.push({ role: 'assistant', content: msg.content });
        const stop = msg.stop_reason === 'tool_use' ? 'tool_use'
          : msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence' ? 'end'
            : msg.stop_reason === 'max_tokens' ? 'max_tokens'
              : msg.stop_reason === 'pause_turn' ? 'pause'
                : 'other';
        return { stop, toolCalls, text, ...(stop === 'other' ? { detail: String(msg.stop_reason) } : {}) };
      }
    },

    addToolResults(results: ToolResult[]) {
      messages.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: r.isError,
        })),
      });
    },

    describeError(e: unknown): ProviderError {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Anthropic.APIUserAbortError) return { kind: 'aborted', message };
      if (e instanceof Anthropic.APIConnectionError) return { kind: 'network', message };
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        return { kind: 'auth', status: e.status, message };
      }
      if (e instanceof Anthropic.RateLimitError) return { kind: 'rate', status: e.status, message };
      if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) {
        return { kind: 'invalid', status: e.status, message };
      }
      if (e instanceof Anthropic.APIError) {
        return { kind: (e.status ?? 0) >= 500 ? 'server' : 'other', ...(e.status ? { status: e.status } : {}), message };
      }
      return { kind: 'other', message };
    },
  };
}
