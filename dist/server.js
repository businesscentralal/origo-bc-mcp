import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerWhoAmI } from "./tools/whoami.js";
import { registerTableMetadataTools } from "./tools/tableMetadata.js";
import { registerDataRecordTools } from "./tools/dataRecords.js";
import { registerSearchTools } from "./tools/search.js";
import { registerTotalsTools } from "./tools/totals.js";
import { registerMessageTypeTools } from "./tools/messageTypes.js";
import { registerQueueTools } from "./tools/queue.js";
import { registerAgingTools } from "./tools/aging.js";
import { registerPeriodBreakdownTools } from "./tools/periodBreakdown.js";
import { registerTranslationTools } from "./tools/translations.js";
import { registerIntegrationTimestampTools } from "./tools/integrationTimestamps.js";
import { registerMemoryConfigTools } from "./tools/memoryConfig.js";
import { registerIncomingDocumentTools } from "./tools/incomingDocuments.js";
import { registerCryptoTools } from "./tools/crypto.js";
import { registerCloudEventsSkillTools } from "./tools/cloudEventsSkill.js";
import { registerBcEventSubscriptionTools } from "./tools/bcEventSubscriptions.js";
import { registerSessionBootstrap } from "./tools/sessionBootstrap.js";
import { registerMessageTypesLite } from "./tools/messageTypes.js";
/**
 * Builds a fresh MCP server instance with all tools registered.
 * One instance is created per Streamable HTTP session.
 */
export function buildServer() {
    const server = new McpServer({
        name: "origo-bc-mcp",
        version: "0.1.0",
    });
    registerWhoAmI(server);
    registerDiscoveryTools(server);
    registerTableMetadataTools(server);
    registerDataRecordTools(server);
    registerSearchTools(server);
    registerTotalsTools(server);
    registerMessageTypeTools(server);
    registerQueueTools(server);
    registerAgingTools(server);
    registerPeriodBreakdownTools(server);
    registerTranslationTools(server);
    registerIntegrationTimestampTools(server);
    registerMemoryConfigTools(server);
    registerIncomingDocumentTools(server);
    registerCryptoTools(server);
    registerCloudEventsSkillTools(server);
    registerBcEventSubscriptionTools(server);
    registerSessionBootstrap(server);
    return server;
}
/**
 * Builds a lite MCP server with reduced tool count (~23 tools) for local LLMs.
 * Relies on invoke_message_type as the universal tool for most BC operations.
 */
export function buildLiteServer() {
    const server = new McpServer({
        name: "origo-bc-mcp",
        version: "0.1.0",
    });
    registerWhoAmI(server); // 1 tool
    registerMessageTypesLite(server); // 3 tools: invoke_message_type, list_message_types, get_message_type_help
    registerDataRecordTools(server); // 5 tools: get_records, set_records, get_record_ids, batch_records, get_document_lines
    registerAgingTools(server); // 2 tools
    registerPeriodBreakdownTools(server); // 1 tool
    registerCryptoTools(server); // 3 tools
    registerCloudEventsSkillTools(server); // 1 tool
    registerMemoryConfigTools(server); // 6 tools (user + company memory)
    registerSessionBootstrap(server); // 0 tools (prompts only)
    return server;
}
//# sourceMappingURL=server.js.map