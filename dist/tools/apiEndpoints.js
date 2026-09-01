/**
 * API endpoint discovery, metadata inspection, and testing tools.
 * Operates on BC's standard API v2.0 and custom API pages via OData.
 */
import { z } from "zod";
import { resolveTarget, bcApiRequest, json } from "../bc/runtime.js";
const ENTITY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
function validateEntity(name) {
    if (!ENTITY_RE.test(name)) {
        throw new Error(`Invalid entity name: '${name}'.`);
    }
}
function parseEntitySets(xml) {
    const sets = [];
    const re = /<EntitySet\s+[^>]*Name="([^"]+)"[^>]*EntityType="([^"]+)"[^>]*\/?>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        sets.push({ name: m[1], entityType: m[2] });
    }
    return sets;
}
function parseEntityType(xml, typeName) {
    // Strip namespace prefix for matching
    const shortName = typeName.includes(".") ? typeName.split(".").pop() : typeName;
    const typeRe = new RegExp(`<EntityType\\s+Name="${shortName}"[^>]*>([\\s\\S]*?)</EntityType>`);
    const tm = typeRe.exec(xml);
    if (!tm)
        return null;
    const block = tm[1];
    const keys = [];
    const keyRe = /<PropertyRef\s+Name="([^"]+)"/g;
    let km;
    while ((km = keyRe.exec(block)) !== null)
        keys.push(km[1]);
    const properties = [];
    const propRe = /<Property\s+([^>]*)\/?>/g;
    let pm;
    while ((pm = propRe.exec(block)) !== null) {
        const attrs = pm[1];
        const name = attrs.match(/Name="([^"]+)"/)?.[1] ?? "";
        const type = attrs.match(/Type="([^"]+)"/)?.[1] ?? "";
        const nullable = !attrs.includes('Nullable="false"');
        const maxLenMatch = attrs.match(/MaxLength="(\d+)"/);
        const scaleMatch = attrs.match(/Scale="([^"]+)"/);
        if (name) {
            const prop = { name, type, nullable };
            if (maxLenMatch)
                prop.maxLength = Number(maxLenMatch[1]);
            if (scaleMatch)
                prop.scale = scaleMatch[1];
            properties.push(prop);
        }
    }
    const navProperties = [];
    // Match nav properties including their child ReferentialConstraint elements
    const navBlockRe = /<NavigationProperty\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/NavigationProperty>)/g;
    let nm;
    while ((nm = navBlockRe.exec(block)) !== null) {
        const attrs = nm[1];
        const inner = nm[2] ?? "";
        const name = attrs.match(/Name="([^"]+)"/)?.[1] ?? "";
        const type = attrs.match(/Type="([^"]+)"/)?.[1] ?? "";
        const containsTarget = attrs.includes('ContainsTarget="true"');
        if (!name)
            continue;
        const nav = { name, type, containsTarget };
        const rcRe = /<ReferentialConstraint\s+Property="([^"]+)"\s+ReferencedProperty="([^"]+)"/g;
        let rc;
        const constraints = [];
        while ((rc = rcRe.exec(inner)) !== null) {
            constraints.push({ property: rc[1], referencedProperty: rc[2] });
        }
        if (constraints.length)
            nav.referentialConstraints = constraints;
        navProperties.push(nav);
    }
    return { name: shortName, keys, properties, navProperties };
}
// ── Shared schema fragments ─────────────────────────────────────────────────
const apiRouteSchema = {
    publisher: z.string().optional().describe("Custom API publisher (e.g. 'microsoft'). Omit for standard v2.0."),
    group: z.string().optional().describe("Custom API group (e.g. 'automation'). Omit for standard v2.0."),
    version: z.string().optional().describe("Custom API version (e.g. 'v2.0'). Omit for standard v2.0."),
    companyId: z.string().optional(),
};
// ── Tool registration ───────────────────────────────────────────────────────
export function registerApiEndpointTools(server) {
    // ── bc_list_api_endpoints ─────────────────────────────────────────────────
    server.registerTool("bc_list_api_endpoints", {
        title: "List API endpoints",
        description: "Discovers available entity sets on the BC API by fetching the OData $metadata document. " +
            "Defaults to the standard API v2.0 (customers, items, salesOrders, etc.). " +
            "Supply publisher/group/version to query a custom API route instead.",
        inputSchema: apiRouteSchema,
    }, async ({ publisher, group, version, companyId }) => {
        const t = await resolveTarget({ companyId });
        const opts = publisher && group && version ? { publisher, group, version } : undefined;
        const res = await bcApiRequest(t.tenantId, t.environment, "GET", "$metadata", { ...opts, accept: "application/xml" });
        if (res.status !== 200) {
            return json({ error: `$metadata request failed (HTTP ${res.status})`, body: res.body });
        }
        const xml = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
        const entitySets = parseEntitySets(xml);
        return json({
            apiRoute: publisher && group && version
                ? `${publisher}/${group}/${version}`
                : "v2.0 (standard)",
            entitySets,
            count: entitySets.length,
            durationMs: res.durationMs,
        });
    });
    // ── bc_get_api_metadata ───────────────────────────────────────────────────
    server.registerTool("bc_get_api_metadata", {
        title: "Get API entity metadata",
        description: "Inspects the schema of a specific API entity set — fields with types, " +
            "key fields, nullable flags, and navigation properties. " +
            "Parses the OData $metadata EDMX for the entity type backing the given entity set name.",
        inputSchema: {
            entity: z.string().describe("Entity set name (e.g. 'customers', 'salesOrders')."),
            ...apiRouteSchema,
        },
    }, async ({ entity, publisher, group, version, companyId }) => {
        validateEntity(entity);
        const t = await resolveTarget({ companyId });
        const opts = publisher && group && version ? { publisher, group, version } : undefined;
        const res = await bcApiRequest(t.tenantId, t.environment, "GET", "$metadata", { ...opts, accept: "application/xml" });
        if (res.status !== 200) {
            return json({ error: `$metadata request failed (HTTP ${res.status})`, body: res.body });
        }
        const xml = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
        const entitySets = parseEntitySets(xml);
        const match = entitySets.find((s) => s.name.toLowerCase() === entity.toLowerCase());
        if (!match) {
            return json({
                error: `Entity set '${entity}' not found in $metadata.`,
                available: entitySets.map((s) => s.name),
            });
        }
        const entityType = parseEntityType(xml, match.entityType);
        if (!entityType) {
            return json({ error: `Entity type '${match.entityType}' definition not found in $metadata.` });
        }
        return json({
            entitySet: match.name,
            entityType: match.entityType,
            keys: entityType.keys,
            fields: entityType.properties.map((p) => ({
                name: p.name,
                type: p.type,
                nullable: p.nullable,
                isKey: entityType.keys.includes(p.name),
                ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
                ...(p.scale !== undefined ? { scale: p.scale } : {}),
            })),
            navigationProperties: entityType.navProperties,
            durationMs: res.durationMs,
        });
    });
    // ── bc_api_request ────────────────────────────────────────────────────────
    server.registerTool("bc_api_request", {
        title: "Test API endpoint",
        description: "Makes an HTTP request against a BC API/OData endpoint. Supports GET (query), " +
            "POST (create), PATCH (update), and DELETE. Use this to verify that API endpoints " +
            "work correctly, test filters, or perform CRUD operations via the API layer.\n\n" +
            "GET: returns matching records. POST: sends body to create a record. " +
            "PATCH: updates a record by id (requires id, body). DELETE: removes a record by id. " +
            "PATCH and DELETE send an If-Match header (etag or '*').",
        inputSchema: {
            entity: z.string().describe("Entity set name (e.g. 'customers')."),
            method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET").describe("HTTP method."),
            id: z.string().optional().describe("Record GUID — required for PATCH and DELETE."),
            body: z.record(z.unknown()).optional().describe("Request payload — required for POST and PATCH."),
            etag: z.string().optional().describe("If-Match header value. Defaults to '*'."),
            filter: z.string().optional().describe("OData $filter (GET only)."),
            select: z.string().optional().describe("OData $select — comma-separated field names."),
            top: z.number().int().optional().describe("OData $top — max records to return."),
            orderby: z.string().optional().describe("OData $orderby."),
            expand: z.string().optional().describe("OData $expand — navigation properties to inline."),
            ...apiRouteSchema,
        },
    }, async ({ entity, method, id, body, etag, filter, select, top, orderby, expand, publisher, group, version, companyId }) => {
        validateEntity(entity);
        const t = await resolveTarget({ companyId });
        const opts = publisher && group && version ? { publisher, group, version } : undefined;
        if ((method === "PATCH" || method === "DELETE") && !id) {
            throw new Error(`${method} requires an id (record GUID).`);
        }
        if ((method === "POST" || method === "PATCH") && !body) {
            throw new Error(`${method} requires a body.`);
        }
        // Build the resource path: companies({companyId})/entity or companies({companyId})/entity({id})
        let path = `companies(${t.companyId})/${entity}`;
        if (id)
            path += `(${id})`;
        // OData query params (GET only, but $select/$expand can be useful on POST/PATCH responses too)
        const params = {};
        if (filter)
            params["$filter"] = filter;
        if (select)
            params["$select"] = select;
        if (top !== undefined)
            params["$top"] = String(top);
        if (orderby)
            params["$orderby"] = orderby;
        if (expand)
            params["$expand"] = expand;
        const res = await bcApiRequest(t.tenantId, t.environment, method, path, {
            ...opts,
            params: Object.keys(params).length ? params : undefined,
            body,
            etag,
        });
        const resBody = res.body;
        const result = {
            entity,
            method,
            statusCode: res.status,
            durationMs: res.durationMs,
        };
        if (method === "GET") {
            const rows = Array.isArray(resBody?.value) ? resBody.value : [];
            result.rowCount = rows.length;
            result.hasMore = typeof resBody?.["@odata.nextLink"] === "string";
            result.rows = rows;
            if (resBody?.["@odata.context"])
                result.odataContext = resBody["@odata.context"];
        }
        else if (method === "POST") {
            result.created = resBody;
        }
        else if (method === "PATCH") {
            result.updated = resBody;
        }
        else if (method === "DELETE") {
            result.deleted = res.status >= 200 && res.status < 300;
        }
        if (res.status >= 400) {
            result.error = resBody;
        }
        if (res.headers["etag"])
            result.etag = res.headers["etag"];
        return json(result);
    });
}
//# sourceMappingURL=apiEndpoints.js.map