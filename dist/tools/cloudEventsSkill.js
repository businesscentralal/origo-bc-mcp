/**
 * Cloud Events API skill tool — get_cloud_events_api_skill.
 * Fetches and caches SKILL.md from Azure Blob Storage.
 */
import { z } from "zod";
import { json } from "../bc/runtime.js";
const SKILL_URL = "https://origopublic.blob.core.windows.net/help/Cloud%20Events/bc27/en-US/SKILL.md";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cached = null;
async function fetchSkill() {
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS)
        return cached.text;
    const res = await fetch(SKILL_URL);
    if (!res.ok)
        throw new Error(`Failed to fetch SKILL.md: ${res.status} ${res.statusText}`);
    const text = await res.text();
    cached = { text, timestamp: Date.now() };
    return text;
}
function extractToc(md) {
    const lines = md.split("\n");
    return lines
        .filter((l) => /^#{1,4}\s/.test(l))
        .map((l) => {
        const m = l.match(/^(#{1,4})\s+(.*)/);
        if (!m)
            return l;
        const depth = m[1].length - 1;
        return "  ".repeat(depth) + "- " + m[2].trim();
    })
        .join("\n");
}
function extractSection(md, heading) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`^(#{1,4})\\s+${escaped}\\s*$`, "im");
    const match = rx.exec(md);
    if (!match || match.index == null)
        return null;
    const startLevel = match[1].length;
    const afterHeading = md.slice(match.index + match[0].length);
    const endRx = new RegExp(`^#{1,${startLevel}}\\s`, "m");
    const endMatch = endRx.exec(afterHeading);
    const content = endMatch && endMatch.index != null ? afterHeading.slice(0, endMatch.index) : afterHeading;
    return (match[0] + content).trim();
}
export function registerCloudEventsSkillTools(server) {
    server.registerTool("get_cloud_events_api_skill", {
        title: "Cloud Events API skill",
        description: "Fetches the Cloud Events API skill document (SKILL.md). " +
            "Modes: 'toc' returns table of contents (default), 'section' returns a specific section by heading, 'full' returns the entire document.",
        inputSchema: {
            mode: z.enum(["toc", "section", "full"]).optional().describe("Retrieval mode (default 'toc')."),
            heading: z.string().optional().describe("Section heading to retrieve (required when mode='section')."),
        },
    }, async ({ mode = "toc", heading }) => {
        const md = await fetchSkill();
        if (mode === "full") {
            return json({ mode: "full", length: md.length, content: md });
        }
        if (mode === "section") {
            if (!heading)
                throw new Error("Parameter 'heading' is required when mode='section'.");
            const section = extractSection(md, heading);
            if (!section) {
                const toc = extractToc(md);
                return json({ mode: "section", heading, found: false, hint: "Section not found. Available headings:", toc });
            }
            return json({ mode: "section", heading, found: true, content: section });
        }
        // toc (default)
        return json({ mode: "toc", toc: extractToc(md) });
    });
}
//# sourceMappingURL=cloudEventsSkill.js.map