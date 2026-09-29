/**
 * Help.Implementation.Get — one reader for every contract Business Central answers with.
 *
 * Three shapes are live at the same time, depending on which app handles the call:
 *
 * 1. **Markdown** (legacy Origo Cloud Events Core, Bifrost Foundation before core#183):
 *    `datacontenttype: text/markdown`, so `bcTask` returns `{ result: "<markdown>" }`.
 * 2. **JSON array** (Foundation core#183): `{ status, result: [ { name, …catalogue fields…, markdown } ] }`.
 *    The markdown ends with a shared "Errors and warnings" section.
 * 3. **Chapters** (Foundation core#194, message type contracts): the same array, but a type with a
 *    contract (`hasContract: true`) returns its help as separate JSON chapters (`envelope`, `parameters`,
 *    `errors`, `effect`, …) and no `markdown`; a type without one still returns `markdown`. The shared
 *    "Errors and warnings" text comes once per call as `conventions.errorsAndWarnings`.
 *
 * Nothing here keys on a version: the shape of the response decides.
 */
/** The chapter keys a contract type may return (core#143). */
export const CHAPTER_KEYS = [
    "envelope",
    "target",
    "parameters",
    "response",
    "errors",
    "effect",
    "metering",
    "related",
    "workflow",
    "examples",
    "overview",
    "notes",
];
/** Catalogue fields a JSON element carries next to its help. */
const CATALOGUE_KEYS = [
    "isEnabled",
    "filterTableNo",
    "description",
    "selectionDescription",
    "messageDirection",
    "keywords",
    "chargeable",
    "hasContract",
];
/** An element-level error: the name was not found among several requested ones. */
export class HelpElementError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = "HelpElementError";
        this.code = code;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pickElement(elements, messageType) {
    const records = elements.filter(isRecord);
    return (records.find((e) => e.name === messageType) ??
        records.find((e) => typeof e.name === "string" && e.name.toLowerCase() === messageType.toLowerCase()) ??
        (records.length === 1 ? records[0] : undefined));
}
function readConventions(response) {
    const conventions = response.conventions;
    if (isRecord(conventions) && typeof conventions.errorsAndWarnings === "string") {
        return conventions.errorsAndWarnings;
    }
    return undefined;
}
function fromElement(element, response) {
    if (element.status === "Error") {
        const error = isRecord(element.error) ? element.error : {};
        const message = typeof error.message === "string" ? error.message : `Help for ${String(element.name)} failed.`;
        throw new HelpElementError(message, typeof error.code === "string" ? error.code : undefined);
    }
    const catalogue = {};
    if (typeof element.name === "string")
        catalogue.name = element.name;
    for (const key of CATALOGUE_KEYS) {
        if (key in element)
            catalogue[key] = element[key];
    }
    const chapters = {};
    for (const key of CHAPTER_KEYS) {
        if (key in element)
            chapters[key] = element[key];
    }
    const help = { contract: "json", format: "summary", catalogue };
    const markdown = typeof element.markdown === "string" ? element.markdown : undefined;
    // `metering` is built by Foundation for every type, so on its own it does not make a type a
    // chapter type; `hasContract` (or any other chapter) does.
    const hasOwnChapters = Object.keys(chapters).some((key) => key !== "metering");
    if (element.hasContract === true || (hasOwnChapters && markdown === undefined)) {
        help.format = "chapters";
        help.chapters = chapters;
    }
    else if (markdown !== undefined) {
        help.format = "markdown";
        help.markdown = markdown;
        if (Object.keys(chapters).length > 0)
            help.chapters = chapters;
    }
    else if (Object.keys(chapters).length > 0) {
        help.chapters = chapters;
    }
    const conventions = readConventions(response);
    if (conventions !== undefined)
        help.conventions = conventions;
    if (Array.isArray(response.warnings) && response.warnings.length > 0)
        help.warnings = response.warnings;
    return help;
}
/**
 * Turns whatever `bcTask` returned for `Help.Implementation.Get` into one shape.
 *
 * @param response What `bcTask` resolved with.
 * @param messageType The type the help was asked for; picks the element out of a JSON array.
 * @throws HelpElementError when the JSON answer marks that type's element as an error.
 */
export function normalizeImplementationHelp(response, messageType) {
    if (!isRecord(response)) {
        return typeof response === "string"
            ? { contract: "markdown", format: "markdown", markdown: response }
            : { contract: "unknown", format: "unknown", raw: response };
    }
    const result = response.result;
    // 1. Markdown contract: bcTask wraps a text/markdown body as { result: "<markdown>" }.
    if (typeof result === "string") {
        return { contract: "markdown", format: "markdown", markdown: result };
    }
    // 2 and 3. JSON contract: result is always an array, one element per requested name.
    if (Array.isArray(result)) {
        const element = pickElement(result, messageType);
        if (element)
            return fromElement(element, response);
        return { contract: "json", format: "unknown", raw: response };
    }
    // A single JSON object carrying the document directly (an early draft of core#171).
    if (typeof response.markdown === "string" || typeof response.name === "string") {
        return fromElement(response, response);
    }
    return { contract: "unknown", format: "unknown", raw: response };
}
/**
 * The help as one text, for places that can only show text (an error message, a log line).
 * Markdown as it is; chapters as indented JSON; the shared conventions appended once.
 */
export function helpAsText(help) {
    const parts = [];
    if (help.markdown !== undefined) {
        parts.push(help.markdown);
    }
    else if (help.chapters !== undefined) {
        parts.push(JSON.stringify(help.chapters, null, 2));
    }
    else if (help.raw !== undefined) {
        parts.push(typeof help.raw === "string" ? help.raw : JSON.stringify(help.raw, null, 2));
    }
    else if (help.catalogue !== undefined) {
        parts.push(JSON.stringify(help.catalogue, null, 2));
    }
    if (help.conventions !== undefined)
        parts.push(help.conventions);
    return parts.join("\n\n");
}
//# sourceMappingURL=implementationHelp.js.map