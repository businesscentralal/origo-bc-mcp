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
import { registerUblTools } from "./tools/ubl.js";
import { registerBcEventSubscriptionTools } from "./tools/bcEventSubscriptions.js";
import { registerSessionBootstrap } from "./tools/sessionBootstrap.js";
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
    registerUblTools(server);
    registerBcEventSubscriptionTools(server);
    registerSessionBootstrap(server);
    return server;
}
//# sourceMappingURL=server.js.map