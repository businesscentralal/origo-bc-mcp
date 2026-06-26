/**
 * Ring buffer that intercepts console.log/error/warn and stores
 * recent lines for the dashboard. Subscribers get real-time SSE pushes.
 */
const MAX_LINES = 2000;
const buffer = [];
const subscribers = new Set();
function push(level, args) {
    const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    const entry = { ts: Date.now(), level, text };
    buffer.push(entry);
    if (buffer.length > MAX_LINES)
        buffer.shift();
    for (const fn of subscribers) {
        try {
            fn(entry);
        }
        catch { /* subscriber error — ignore */ }
    }
}
/** Subscribe to new log entries. Returns unsubscribe function. */
export function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}
/** Get the last N buffered lines (default: all). */
export function getBuffer(n) {
    return n ? buffer.slice(-n) : [...buffer];
}
/** Number of active SSE subscribers. */
export function subscriberCount() {
    return subscribers.size;
}
// --- Intercept console ---------------------------------------------------
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.log = (...args) => { origLog(...args); push("log", args); };
console.error = (...args) => { origError(...args); push("error", args); };
console.warn = (...args) => { origWarn(...args); push("warn", args); };
//# sourceMappingURL=logBuffer.js.map