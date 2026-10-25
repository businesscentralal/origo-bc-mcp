import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRemoteTestScript, clientServicesCodeunitFilter } from "../dist/bc/runTests.js";

const conn = { user: "admin", key: "secret", companyName: "CRONUS IS", onPremTenant: "default" };

function script(input) {
    return buildRemoteTestScript(input, conn);
}

/** The Client Services Run-Tests splat, not the host-helper splat. */
function clientServicesBlock(ps) {
    const start = ps.indexOf("$rtParams = @{");
    assert.ok(start >= 0, "missing $rtParams");
    const end = ps.indexOf("$allPassed = Run-Tests @rtParams", start);
    assert.ok(end > start, "missing Run-Tests splat");
    return ps.slice(start, end);
}

describe("clientServicesCodeunitFilter", () => {
    it("maps a numeric testCodeunit to an id..id range and drops TestCodeunit on page 130455", () => {
        assert.deepEqual(clientServicesCodeunitFilter({ testCodeunit: "99012", extensionId: "11111111-1111-1111-1111-111111111111" }), {
            testCodeunit: "99012",
            testCodeunitRange: "99012..99012",
            testCodeunitOn130455: "",
        });
    });

    it("trims the id before mapping", () => {
        assert.equal(clientServicesCodeunitFilter({ testCodeunit: " 99012 " }).testCodeunitRange, "99012..99012");
    });

    it("leaves name and wildcard filters on TestCodeunit", () => {
        assert.deepEqual(clientServicesCodeunitFilter({ testCodeunit: "Bifrost*" }), {
            testCodeunit: "Bifrost*",
            testCodeunitRange: "",
            testCodeunitOn130455: "Bifrost*",
        });
    });

    it("does not invent a range when no codeunit filter is set", () => {
        assert.deepEqual(clientServicesCodeunitFilter({}), {
            testCodeunit: "",
            testCodeunitRange: "",
            testCodeunitOn130455: "",
        });
        assert.deepEqual(clientServicesCodeunitFilter({ testCodeunit: "*" }), {
            testCodeunit: "*",
            testCodeunitRange: "",
            testCodeunitOn130455: "*",
        });
    });

    it("lets an explicit testCodeunitRange win over a numeric id", () => {
        assert.deepEqual(clientServicesCodeunitFilter({ testCodeunit: "99012", testCodeunitRange: "99000..99100" }), {
            testCodeunit: "99012",
            testCodeunitRange: "99000..99100",
            testCodeunitOn130455: "",
        });
    });

    it("passes an explicit range through with a name filter", () => {
        assert.deepEqual(clientServicesCodeunitFilter({ testCodeunit: "My Tests", testCodeunitRange: "99012" }), {
            testCodeunit: "My Tests",
            testCodeunitRange: "99012",
            testCodeunitOn130455: "My Tests",
        });
    });
});

describe("buildRemoteTestScript Client Services params", () => {
    it("applies a non-empty range for numeric testCodeunit + extensionId and does not pass that id as TestCodeunit", () => {
        const ps = script({
            extensionId: "8f3e1c0a-1111-2222-3333-444455556666",
            testCodeunit: "99012",
        });
        assert.match(ps, /\$testCodeunit = '99012'/);
        assert.match(ps, /\$testCodeunitRange = '99012\.\.99012'/);
        assert.match(ps, /\$testCodeunitOn130455 = ''/);
        const block = clientServicesBlock(ps);
        const page130455 = block.slice(block.indexOf("if ($testPage -eq 130455)"), block.indexOf("} elseif ($testCodeunit)"));
        assert.match(page130455, /\$rtParams\.TestCodeunitRange = \$testCodeunitRange/);
        assert.match(page130455, /\$rtParams\.TestCodeunit = \$testCodeunitOn130455/);
        assert.doesNotMatch(page130455, /\$rtParams\.TestCodeunit = \$testCodeunit\b/);
        assert.match(block, /\$rtParams\.ExtensionId = \$extensionId/);
        // Legacy pages still receive the original id.
        assert.match(block, /elseif \(\$testCodeunit\) \{\s*\$rtParams\.TestCodeunit = \$testCodeunit/);
        // Host helper path is unchanged.
        assert.match(ps, /if \(\$testCodeunit\) \{ \$params\.testCodeunit = \$testCodeunit \}/);
    });

    it("keeps a name filter on TestCodeunit for page 130455", () => {
        const block = clientServicesBlock(script({ testCodeunit: "Warmup*" }));
        assert.match(block, /\$rtParams\.TestCodeunit = \$testCodeunitOn130455/);
        assert.match(script({ testCodeunit: "Warmup*" }), /\$testCodeunitOn130455 = 'Warmup\*'/);
        assert.match(script({ testCodeunit: "Warmup*" }), /\$testCodeunitRange = ''/);
    });

    it("emits an explicit range and still loads ExtensionId", () => {
        const ps = script({ extensionId: "abc", testCodeunitRange: "99012..99015" });
        assert.match(ps, /\$testCodeunitRange = '99012\.\.99015'/);
        assert.match(ps, /\$testCodeunit = ''/);
        assert.match(clientServicesBlock(ps), /\$rtParams\.ExtensionId = \$extensionId/);
    });

    it("escapes quotes in the range", () => {
        const ps = script({ testCodeunitRange: "99012'..99012" });
        assert.match(ps, /\$testCodeunitRange = '99012''\.\.99012'/);
    });
});
