/**
 * Cosmo container SSH: read the SSH endpoint and make it usable.
 *
 * Cosmo's SSH endpoint (GET /Container/Ssh/{id}) can drop out while the container keeps running -
 * the container record carries no ssh flag, and a PATCH sshEnabled=true brings it back after a
 * minute or two. `ensureCosmoSsh` does that in one call: check, enable, poll until the endpoint has an
 * ipAddress + privateKey and accepts TCP, and - only when the caller allows it - Stop → Start the
 * container as a last resort. The private key never leaves this module's callers; results carry
 * presence flags only.
 */
import { createConnection } from "node:net";
import { cosmoRequest } from "./client.js";
export function normalizeSshInfo(body, httpStatus) {
    const obj = body && typeof body === "object" ? body : {};
    const available = obj.available === true;
    const ipAddress = typeof obj.ipAddress === "string" ? obj.ipAddress : typeof obj.host === "string" ? obj.host : undefined;
    const port = obj.port !== undefined && obj.port !== null ? String(obj.port) : undefined;
    const privateKey = typeof obj.privateKey === "string"
        ? obj.privateKey
        : typeof obj.PrivateKey === "string"
            ? obj.PrivateKey
            : undefined;
    return {
        available,
        ipAddress: ipAddress?.trim() || undefined,
        port: port?.trim() || undefined,
        privateKey: privateKey?.trim() || undefined,
        httpStatus,
        rawKeys: Object.keys(obj),
    };
}
export async function fetchCosmoSshInfo(containerId) {
    const res = await cosmoRequest("GET", `/Container/Ssh/${encodeURIComponent(containerId)}`);
    return normalizeSshInfo(res.body, res.status);
}
export function sshUsable(ssh) {
    // After Stop→Start, available may stay false while Starting even when ipAddress + RSA privateKey
    // are already present. Gate on credentials, not available.
    return Boolean(ssh.ipAddress?.trim() && ssh.privateKey?.trim());
}
export async function wait(ms) {
    if (ms <= 0)
        return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}
/** True when the SSH port accepts a TCP connection within 2 s. */
export async function canConnectToSsh(ssh) {
    if (!ssh.ipAddress || !ssh.privateKey)
        return false;
    const port = Number(ssh.port || 22);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (connected) => {
            if (settled)
                return;
            settled = true;
            resolve(connected);
        };
        const socket = createConnection({ host: ssh.ipAddress, port });
        socket.setTimeout(2_000);
        socket.once("connect", () => {
            socket.destroy();
            finish(true);
        });
        socket.once("timeout", () => {
            socket.destroy();
            finish(false);
        });
        socket.once("error", () => {
            socket.destroy();
            finish(false);
        });
    });
}
function envNumber(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}
async function containerState(containerId) {
    const res = await cosmoRequest("GET", `/Container/Container/${encodeURIComponent(containerId)}`);
    const status = res.body?.status;
    return typeof status?.state === "string" ? status.state : undefined;
}
async function patchContainer(containerId, body) {
    const res = await cosmoRequest("PATCH", `/Container/Container/${encodeURIComponent(containerId)}`, { body });
    return res.status;
}
/**
 * Makes the Cosmo SSH endpoint of a container usable and returns it (the caller gets the private key
 * in `info`; `result` is safe to return to a client).
 */
export async function ensureCosmoSsh(containerId, opts = {}) {
    const start = Date.now();
    const waitMs = (opts.waitSeconds ?? envNumber("BC_DEV_SSH_ENSURE_WAIT_S", 300)) * 1000;
    const pollMs = (opts.pollSeconds ?? envNumber("BC_DEV_SSH_ENSURE_POLL_S", 10)) * 1000;
    const checkTcp = opts.checkTcp ?? true;
    const steps = [];
    const step = (action, detail) => steps.push({ atMs: Date.now() - start, action, detail });
    let info;
    let state;
    const isReady = async () => {
        info = await fetchCosmoSshInfo(containerId);
        if (info.httpStatus >= 400 || !sshUsable(info))
            return false;
        return checkTcp ? canConnectToSsh(info) : true;
    };
    const pollUntilReady = async (budgetMs) => {
        const until = Date.now() + budgetMs;
        while (Date.now() < until) {
            await wait(Math.min(pollMs, Math.max(0, until - Date.now())));
            if (await isReady())
                return true;
        }
        return false;
    };
    const finish = (ready, error, hint) => ({
        result: {
            ready,
            containerId,
            ipAddress: info?.ipAddress,
            port: info?.port,
            available: info?.available,
            privateKeyPresent: Boolean(info?.privateKey),
            containerState: state,
            steps,
            elapsedMs: Date.now() - start,
            ...(error ? { error } : {}),
            ...(hint ? { hint } : {}),
        },
        info: ready ? info : undefined,
    });
    try {
        if (await isReady()) {
            step("ready", "SSH endpoint already usable");
            return finish(true);
        }
        state = await containerState(containerId);
        step("notReady", `ip=${Boolean(info?.ipAddress)} key=${Boolean(info?.privateKey)} state=${state ?? "?"}`);
        if (state && state !== "Running") {
            step("start", `container is ${state}; starting it with sshEnabled=true`);
            await patchContainer(containerId, { state: "Start", sshEnabled: true });
        }
        else {
            const status = await patchContainer(containerId, { sshEnabled: true });
            step("enableSsh", `PATCH sshEnabled=true → HTTP ${status}`);
        }
        if (await pollUntilReady(waitMs)) {
            step("ready", "SSH endpoint usable after enabling");
            return finish(true);
        }
        if (!opts.allowRestart) {
            return finish(false, `SSH did not become usable within ${Math.round(waitMs / 1000)} s after enabling it.`, "Retry cosmo_ensure_ssh with allowRestart=true to Stop → Start the container (interrupts anyone using it), " +
                "or wait a little longer and call it again.");
        }
        step("stop", "Stop → Start: stopping the container");
        await patchContainer(containerId, { state: "Stop" });
        const stopUntil = Date.now() + waitMs;
        while (Date.now() < stopUntil) {
            await wait(pollMs);
            state = await containerState(containerId);
            if (state && state !== "Running" && state !== "Stopping")
                break;
        }
        step("start", `starting the container with sshEnabled=true (was ${state ?? "?"})`);
        await patchContainer(containerId, { state: "Start", sshEnabled: true });
        if (await pollUntilReady(waitMs * 2)) {
            state = await containerState(containerId);
            step("ready", "SSH endpoint usable after Stop → Start");
            return finish(true);
        }
        state = await containerState(containerId);
        return finish(false, "SSH did not become usable even after Stop → Start.", "Check the container in the Cosmo portal; recreating it with sshEnabled=true is the remaining option.");
    }
    catch (err) {
        return finish(false, `cosmo SSH check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=ssh.js.map