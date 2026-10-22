// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Any OpenAI-compatible chat-completions endpoint: OpenAI itself, and the DeepSeek,
 * Qwen, Kimi, GLM and similar services (or a relay in front of them) that speak the same
 * protocol. Plain fetch + server-sent events; no client library.
 *
 * `fetchImpl` is injectable so tools/assistant-selftest.ts can replay recorded streams.
 */

import type {
  Provider, ProviderConfig, ProviderError, ToolCall, ToolResult, TurnHandlers, TurnResult,
} from '../types.js';

interface WireToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      /** DeepSeek and others stream their reasoning separately. */
      reasoning_content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  error?: { message?: string };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Yield the JSON payload of every `data:` line until `[DONE]` or the end of the body. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createOpenAIProvider(cfg: ProviderConfig, fetchImpl: typeof fetch = fetch): Provider {
  const messages: ChatMessage[] = [{ role: 'system', content: cfg.system }];
  const tools = cfg.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  return {
    addUserText(text) {
      messages.push({ role: 'user', content: text });
    },

    async runTurn(h: TurnHandlers, signal: AbortSignal): Promise<TurnResult> {
      const res = await fetchImpl(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, tools, stream: true }),
        signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        let detail = body.slice(0, 400);
        try { detail = (JSON.parse(body) as StreamChunk).error?.message ?? detail; } catch { /* not JSON */ }
        throw new HttpError(res.status, `HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }

      let text = '';
      let finish = '';
      const calls: { id: string; name: string; args: string }[] = [];
      for await (const data of sseData(res.body)) {
        let chunk: StreamChunk;
        try { chunk = JSON.parse(data) as StreamChunk; } catch { continue; }
        if (chunk.error?.message) throw new HttpError(0, chunk.error.message);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        if (d.reasoning_content) h.onThinking(d.reasoning_content);
        if (d.content) { text += d.content; h.onText(d.content); }
        for (const tc of d.tool_calls ?? []) {
          const slot = calls[tc.index] ??= { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const live = calls.filter(Boolean);
      const toolCalls: ToolCall[] = live.map((c, i) => {
        const id = c.id || `call_${messages.length}_${i}`;
        try {
          return { id, name: c.name, input: JSON.parse(c.args || '{}') as unknown };
        } catch {
          return { id, name: c.name, input: c.args, invalidJson: true };
        }
      });
      if (finish === 'content_filter') return { stop: 'refusal', toolCalls: [], text, detail: 'content_filter' };
      if (finish === 'length' && toolCalls.length) return { stop: 'max_tokens', toolCalls: [], text };

      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((c, i) => ({
            id: c.id, type: 'function' as const, function: { name: c.name, arguments: live[i]!.args || '{}' },
          })),
        } : {}),
      });
      // Some servers say "stop" even when the turn carries tool calls.
      const stop = toolCalls.length ? 'tool_use'
        : finish === 'length' ? 'max_tokens'
          : finish === 'stop' || finish === '' ? 'end'
            : 'other';
      return { stop, toolCalls, text, ...(stop === 'other' ? { detail: finish } : {}) };
    },

    addToolResults(results: ToolResult[]) {
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
    },

    describeError(e: unknown): ProviderError {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'aborted', message };
      if (e instanceof HttpError) {
        const s = e.status;
        const kind = s === 401 || s === 403 ? 'auth' : s === 429 ? 'rate'
          : s === 400 || s === 404 || s === 422 ? 'invalid' : s >= 500 ? 'server' : 'other';
        return { kind, ...(s ? { status: s } : {}), message };
      }
      // fetch rejects with a TypeError for DNS, TLS, CORS and offline alike.
      if (e instanceof TypeError) return { kind: 'network', message };
      return { kind: 'other', message };
    },
  };
}
