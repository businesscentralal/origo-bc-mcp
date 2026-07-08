/**
 * OpenAI-compatible proxy for Ollama that fixes the Go serialization bug
 * where `function.arguments` is returned as a JSON object instead of a string.
 *
 * OpenClaw (or any client) points here instead of directly to Ollama.
 * This endpoint forwards the request, then normalizes the response.
 */
import { Router } from "express";
function isDebug() {
    return process.env.MCP_DEBUG === "1";
}
function log(...args) {
    if (isDebug())
        console.log("[ollama-proxy]", ...args);
}
const OLLAMA_BASE = process.env.OLLAMA_PROXY_TARGET || "http://192.168.16.241:11434";
export const ollamaProxyRouter = Router();
/**
 * POST /ollama/v1/chat/completions
 * Accepts OpenAI-format requests, forwards to Ollama's native /api/chat endpoint
 * (which doesn't hang with qwen3 + large tool prompts), then converts the response
 * back to OpenAI format with normalized tool call arguments.
 */
ollamaProxyRouter.post("/v1/chat/completions", async (req, res) => {
    const targetUrl = `${OLLAMA_BASE}/api/chat`;
    const t0 = Date.now();
    // Normalize request: stringify any function.arguments objects in message history
    normalizeRequestMessages(req.body);
    // Normalize message content: Ollama native API requires content as string,
    // but OpenAI format allows arrays like [{type:"text",text:"..."}]
    normalizeMessageContent(req.body);
    // Convert OpenAI-style request to Ollama native format
    // Use streaming so OpenClaw sees tokens immediately (avoids idle timeout + better UX)
    const nativeBody = {
        model: req.body?.model,
        messages: req.body?.messages,
        stream: true,
        options: req.body?.options || {},
    };
    if (req.body?.tools)
        nativeBody.tools = req.body.tools;
    if (req.body?.max_tokens)
        nativeBody.options.num_predict = req.body.max_tokens;
    log(`→ ${targetUrl} model=${nativeBody.model} stream=${nativeBody.stream} bodySize=${JSON.stringify(nativeBody).length} messages=${nativeBody.messages?.length} tools=${req.body?.tools?.length || 0}`);
    try {
        const ollamaRes = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nativeBody),
        });
        if (!ollamaRes.ok) {
            const errText = await ollamaRes.text();
            log(`← ${ollamaRes.status} error: ${errText.slice(0, 200)}`);
            res.status(ollamaRes.status).send(errText);
            return;
        }
        // Streaming: read Ollama native stream, convert each chunk to OpenAI SSE format
        if (nativeBody.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            const reader = ollamaRes.body?.getReader();
            if (!reader) {
                res.status(502).json({ error: "No response body from Ollama" });
                return;
            }
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
                        try {
                            const native = JSON.parse(line);
                            const openaiChunk = nativeChunkToOpenAI(native);
                            if (openaiChunk) {
                                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                            }
                            if (native.done) {
                                res.write("data: [DONE]\n\n");
                            }
                        }
                        catch { /* skip malformed lines */ }
                    }
                }
            }
            finally {
                reader.releaseLock();
                log(`← stream done in ${Date.now() - t0}ms`);
                res.end();
            }
            return;
        }
        // Non-streaming: convert Ollama native response to OpenAI format
        const native = await ollamaRes.json();
        const openaiResponse = nativeToOpenAI(native);
        log(`← 200 in ${Date.now() - t0}ms tool_calls=${!!(openaiResponse.choices?.[0]?.message?.tool_calls)}`);
        res.json(openaiResponse);
    }
    catch (err) {
        const msg = err.message;
        log(`← ERROR in ${Date.now() - t0}ms: ${msg}`);
        res.status(502).json({ error: `Ollama proxy error: ${msg}` });
    }
});
/**
 * GET /ollama/v1/models — pass through model listing
 */
ollamaProxyRouter.get("/v1/models", async (_req, res) => {
    try {
        const r = await fetch(`${OLLAMA_BASE}/v1/models`);
        const body = await r.json();
        res.json(body);
    }
    catch (err) {
        res.status(502).json({ error: `Ollama proxy error: ${err.message}` });
    }
});
/**
 * Convert Ollama native non-streaming response to OpenAI format.
 */
function nativeToOpenAI(native) {
    const msg = native.message || {};
    const message = { role: msg.role || "assistant", content: msg.content || "" };
    // Convert tool_calls and normalize arguments to strings
    if (msg.tool_calls) {
        const toolCalls = msg.tool_calls.map((tc, i) => {
            const fn = tc.function || {};
            return {
                id: `call_${Date.now().toString(36)}_${i}`,
                index: i,
                type: "function",
                function: {
                    name: fn.name,
                    arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments),
                },
            };
        });
        message.tool_calls = toolCalls;
    }
    return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: native.model,
        choices: [{ index: 0, message, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }],
        usage: native.prompt_eval_count != null ? {
            prompt_tokens: native.prompt_eval_count,
            completion_tokens: native.eval_count,
            total_tokens: native.prompt_eval_count + (native.eval_count || 0),
        } : undefined,
    };
}
/**
 * Convert a single Ollama native streaming chunk to OpenAI SSE delta format.
 */
function nativeChunkToOpenAI(native) {
    const msg = native.message;
    if (!msg)
        return null;
    const delta = {};
    if (msg.role)
        delta.role = msg.role;
    if (msg.content)
        delta.content = msg.content;
    if (msg.tool_calls) {
        const toolCalls = msg.tool_calls.map((tc, i) => {
            const fn = tc.function || {};
            return {
                id: `call_${Date.now().toString(36)}_${i}`,
                index: i,
                type: "function",
                function: {
                    name: fn.name,
                    arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments),
                },
            };
        });
        delta.tool_calls = toolCalls;
    }
    return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: native.model,
        choices: [{ index: 0, delta, finish_reason: native.done ? (msg.tool_calls ? "tool_calls" : "stop") : null }],
    };
}
/**
 * Normalize message content from OpenAI array/object format to plain strings.
 * Ollama native API requires content to always be a string.
 */
function normalizeMessageContent(body) {
    if (!body)
        return;
    const messages = body.messages;
    if (!messages)
        return;
    for (const msg of messages) {
        if (msg.content === null || msg.content === undefined) {
            msg.content = "";
        }
        else if (Array.isArray(msg.content)) {
            // Extract text parts and join them
            const textParts = msg.content
                .filter((p) => p.type === "text" || !p.type)
                .map((p) => (p.text || p.content || ""));
            msg.content = textParts.join("\n");
        }
        else if (typeof msg.content === "object") {
            // Stringify any object content (e.g. tool results)
            msg.content = JSON.stringify(msg.content);
        }
    }
}
/**
 * Normalize outbound request for Ollama native API:
 * - Parse string arguments BACK to objects (native API wants objects, not strings)
 * - OpenClaw sends arguments as strings (OpenAI format), Ollama native wants objects
 */
function normalizeRequestMessages(body) {
    if (!body)
        return;
    const messages = body.messages;
    if (!messages)
        return;
    for (const msg of messages) {
        const toolCalls = msg.tool_calls;
        if (!toolCalls)
            continue;
        for (const tc of toolCalls) {
            const fn = tc.function;
            if (!fn)
                continue;
            // Parse string arguments to objects for native API
            if (typeof fn.arguments === "string") {
                try {
                    fn.arguments = JSON.parse(fn.arguments);
                }
                catch { /* leave as-is if not valid JSON */ }
            }
        }
    }
}
/**
 * Fix the core bug: if function.arguments is an object, stringify it.
 */
function normalizeToolCalls(message) {
    const toolCalls = message.tool_calls;
    if (!toolCalls)
        return;
    for (const tc of toolCalls) {
        const fn = tc.function;
        if (!fn)
            continue;
        if (fn.arguments !== undefined && typeof fn.arguments !== "string") {
            fn.arguments = JSON.stringify(fn.arguments);
        }
    }
}
function hasToolCalls(body) {
    const choices = body.choices;
    if (!choices)
        return false;
    return choices.some((c) => {
        const msg = c.message;
        return msg?.tool_calls != null;
    });
}
//# sourceMappingURL=proxy.js.map