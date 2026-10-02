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
export class HttpSessions {
    idleTimeoutMs;
    sessions = new Map();
    constructor(idleTimeoutMs = 30 * 60_000) {
        this.idleTimeoutMs = idleTimeoutMs;
    }
    add(id, transport) {
        const now = Date.now();
        this.sessions.set(id, { transport, created: now, lastActive: now, activeRequests: 0 });
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
        for (const [id, session] of this.sessions) {
            if (session.activeRequests > 0 || now - session.lastActive < this.idleTimeoutMs)
                continue;
            this.remove(id);
            try {
                await session.transport.close();
            }
            catch (err) {
                console.error("[MCP] Session cleanup failed:", err.message);
            }
        }
    }
}
//# sourceMappingURL=httpSessions.js.map