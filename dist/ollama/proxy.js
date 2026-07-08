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
 * Proxies to Ollama's OpenAI-compatible endpoint and normalizes tool call arguments.
 */
ollamaProxyRouter.post("/v1/chat/completions", async (req, res) => {
    const targetUrl = `${OLLAMA_BASE}/v1/chat/completions`;
    const t0 = Date.now();
    // Normalize request: stringify any function.arguments objects in message history
    // (OpenClaw may send them as objects; Ollama's Go expects strings)
    normalizeRequestMessages(req.body);
    // Pass through num_ctx from the client if provided (top-level or options).
    // This lets the model's Modelfile default apply when no override is sent.
    const numCtx = req.body?.num_ctx || req.body?.options?.num_ctx;
    if (numCtx) {
        if (!req.body.options)
            req.body.options = {};
        req.body.options.num_ctx = numCtx;
    }
    log(`→ ${targetUrl} model=${req.body?.model} num_ctx=${req.body?.options?.num_ctx || 'model-default'}`);
    try {
        const ollamaRes = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
        });
        if (!ollamaRes.ok) {
            const errText = await ollamaRes.text();
            log(`← ${ollamaRes.status} error: ${errText.slice(0, 200)}`);
            res.status(ollamaRes.status).send(errText);
            return;
        }
        // Streaming: pass through and normalize each SSE chunk
        if (req.body?.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            const reader = ollamaRes.body?.getReader();
            if (!reader) {
                res.status(502).json({ error: "No response body from Ollama" });
                return;
            }
            const decoder = new TextDecoder();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    const chunk = decoder.decode(value, { stream: true });
                    // Normalize each SSE line that contains tool_calls
                    const normalized = normalizeStreamChunk(chunk);
                    res.write(normalized);
                }
            }
            finally {
                reader.releaseLock();
                log(`← stream done in ${Date.now() - t0}ms`);
                res.end();
            }
            return;
        }
        // Non-streaming: parse, normalize, return
        const body = await ollamaRes.json();
        normalizeResponse(body);
        log(`← 200 in ${Date.now() - t0}ms choices=${body.choices?.length} tool_calls=${hasToolCalls(body)}`);
        res.json(body);
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
 * Normalize a non-streaming response: ensure all function.arguments are strings.
 */
function normalizeResponse(body) {
    const choices = body.choices;
    if (!choices)
        return;
    for (const choice of choices) {
        const message = choice.message;
        if (!message)
            continue;
        normalizeToolCalls(message);
    }
}
/**
 * Normalize streaming SSE chunks containing tool_calls.
 */
function normalizeStreamChunk(chunk) {
    // SSE format: "data: {...}\n\n"
    return chunk.replace(/^data: (.+)$/gm, (_match, jsonStr) => {
        if (jsonStr === "[DONE]")
            return `data: [DONE]`;
        try {
            const parsed = JSON.parse(jsonStr);
            const choices = parsed.choices;
            if (choices) {
                for (const choice of choices) {
                    const delta = choice.delta;
                    if (delta)
                        normalizeToolCalls(delta);
                }
            }
            return `data: ${JSON.stringify(parsed)}`;
        }
        catch {
            // Not valid JSON, pass through unchanged
            return `data: ${jsonStr}`;
        }
    });
}
/**
 * Normalize outbound request: stringify function.arguments in message history.
 * OpenClaw (or other clients) may send tool_calls with arguments as objects,
 * but Ollama's Go backend requires them as strings.
 */
function normalizeRequestMessages(body) {
    if (!body)
        return;
    const messages = body.messages;
    if (!messages)
        return;
    for (const msg of messages) {
        normalizeToolCalls(msg);
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