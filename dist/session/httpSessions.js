import { clearSession } from "./store.js";
export function closeOnResponse(transport, res) {
    let closed = false;
    const closeTransport = () => {
        if (closed)
            return;
        closed = true;
        void transport.close().catch((err) => console.error("[MCP] Stateless cleanup failed:", err.message));
    };
    res.once("finish", closeTransport);
    res.once("close", closeTransport);
}
/**
 * Drops request bookkeeping whose SSE response stream is gone.
 *
 * When a client disconnects before a tool call finishes (client-side tool timeout on a long
 * publish or test run), the SDK deletes the stream but keeps the request id. When the result
 * arrives, `send()` stores the full JSON-RPC response in `_requestResponseMap` and then throws
 * before its cleanup loop, so the response stays on the heap for the life of the session.
 * Removing the orphaned request id first makes `send()` throw before it stores anything.
 */
export function pruneOrphanedResponses(transport) {
    const inner = transport._webStandardTransport;
    const streams = inner?._streamMapping;
    const byRequest = inner?._requestToStreamMapping;
    const responses = inner?._requestResponseMap;
    if (!(streams instanceof Map && byRequest instanceof Map && responses instanceof Map))
        return 0;
    let pruned = 0;
    for (const [requestId, streamId] of byRequest) {
        if (streams.has(streamId))
            continue;
        byRequest.delete(requestId);
        responses.delete(requestId);
        pruned++;
    }
    return pruned;
}
function envPositiveInt(name, fallback) {
    const value = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
/**
 * Stateful Streamable HTTP sessions. Each session owns a full McpServer (about 2 MB of heap
 * with every tool registered), and clients that exit without DELETE leave their session until
 * the idle timeout. The session cap bounds that memory: when it is exceeded, the least recently
 * used idle sessions are closed (the client gets 404 and re-initializes).
 */
export class HttpSessions {
    idleTimeoutMs;
    maxSessions;
    sessions = new Map();
    constructor(idleTimeoutMs = envPositiveInt("MCP_SESSION_IDLE_MINUTES", 30) * 60_000, maxSessions = envPositiveInt("MCP_MAX_SESSIONS", 150)) {
        this.idleTimeoutMs = idleTimeoutMs;
        this.maxSessions = maxSessions;
    }
    add(id, transport) {
        const now = Date.now();
        this.sessions.set(id, { transport, created: now, lastActive: now, activeRequests: 0 });
        this.evictOverflow(id);
    }
    acquire(id) {
        const session = this.sessions.get(id);
        if (!session)
            return undefined;
        session.lastActive = Date.now();
        session.activeRequests++;
        let released = false;
        return {
            transport: session.transport,
            release: () => {
                if (released)
                    return;
                released = true;
                session.activeRequests--;
                session.lastActive = Date.now();
            },
        };
    }
    remove(id) {
        this.sessions.delete(id);
        clearSession(id);
    }
    list() {
        return [...this.sessions].map(([id, session]) => ({ id, created: session.created }));
    }
    async sweep(now = Date.now()) {
        let expired = 0;
        let pruned = 0;
        for (const [id, session] of this.sessions) {
            if (session.activeRequests > 0 || now - session.lastActive < this.idleTimeoutMs) {
                pruned += pruneOrphanedResponses(session.transport);
                continue;
            }
            this.remove(id);
            expired++;
            await this.closeTransport(session.transport);
        }
        if (expired > 0 || pruned > 0) {
            console.log(`[MCP] Session sweep: expired ${expired} idle, pruned ${pruned} orphaned response(s), ${this.sessions.size} open`);
        }
    }
    evictOverflow(keepId) {
        if (this.sessions.size <= this.maxSessions)
            return;
        const idle = [...this.sessions]
            .filter(([id, session]) => id !== keepId && session.activeRequests === 0)
            .sort(([, a], [, b]) => a.lastActive - b.lastActive);
        let evicted = 0;
        for (const [id, session] of idle) {
            if (this.sessions.size <= this.maxSessions)
                break;
            this.remove(id);
            evicted++;
            void this.closeTransport(session.transport);
        }
        if (evicted > 0) {
            console.warn(`[MCP] Session cap ${this.maxSessions} reached: evicted ${evicted} least recently used idle session(s)`);
        }
    }
    async closeTransport(transport) {
        try {
            await transport.close();
        }
        catch (err) {
            console.error("[MCP] Session cleanup failed:", err.message);
        }
    }
}
//# sourceMappingURL=httpSessions.js.map