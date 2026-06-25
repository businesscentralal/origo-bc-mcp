# Azure DevOps setup — cross-tenant deploy

**The problem:** Azure DevOps lives in **Tenant A**, but the subscription, DNS
zone and deployment targets live in **Tenant B**. The "Service principal
(automatic)" option in DevOps only works within the org's own tenant, so we
create the service principal **manually in Tenant B** and register it as a
**manual** AzureRM service connection.

The pipeline (`azure-pipelines.yml`) references the connection by name:
**`bcmcp-tenantB-arm`**.

---

## 1. Create the service principal in Tenant B

Run on a machine signed in to **Tenant B**:

```bash
az login --tenant <TENANT_B_ID>
az account set --subscription <SUBSCRIPTION_ID_TENANT_B>
SUB=$(az account show --query id -o tsv)

# Contributor + RBAC Administrator at subscription scope.
#  - Contributor:               create the RG and all resources
#  - Role Based Access Control Administrator: required because core.bicep
#    creates role assignments (AcrPull, Key Vault Secrets User). Contributor
#    alone CANNOT create role assignments.
az ad sp create-for-rbac \
  --name "sp-bcmcp-devops" \
  --role "Contributor" \
  --scopes "/subscriptions/$SUB"

# Note the output: appId, password, tenant.

APP_ID=<appId-from-output>

# Add RBAC Administrator (so the deployment can create role assignments).
az role assignment create \
  --assignee "$APP_ID" \
  --role "Role Based Access Control Administrator" \
  --scope "/subscriptions/$SUB"
```

> Alternatively assign **Owner** at subscription scope instead of
> Contributor + RBAC Administrator (simpler for dev, broader rights).

### DNS zone access

The DNS module writes into `origo-dns-rg`.

- If `origo-dns-rg` is in the **same subscription**, the subscription-level role
  above already covers it.
- If it lives in a **different subscription**, grant the SP **DNS Zone
  Contributor** there explicitly:

```bash
az role assignment create \
  --assignee "$APP_ID" \
  --role "DNS Zone Contributor" \
  --scope "/subscriptions/<DNS_SUB>/resourceGroups/origo-dns-rg"
```

---

## 2. Register the manual service connection in DevOps (Tenant A)

Project Settings → **Service connections** → **New service connection** →
**Azure Resource Manager** → **Service principal (manual)**:

| Field | Value |
|---|---|
| Environment | Azure Cloud |
| Scope Level | Subscription |
| Subscription Id | `<SUBSCRIPTION_ID_TENANT_B>` |
| Subscription Name | (the Tenant B subscription name) |
| Service Principal Id | `appId` from step 1 |
| Service Principal Key | `password` from step 1 |
| Tenant Id | **`<TENANT_B_ID>`** (Tenant B, not A) |
| Service connection name | **`bcmcp-tenantB-arm`** |

Click **Verify**, then **Save**. (If your org enforces it, also grant the
pipeline "Allow" access to this connection.)

> **Secretless alternative (recommended long-term):** use Workload Identity
> Federation. Create the connection as "Workload identity federation (manual)",
> then add a federated credential on the Tenant B app registration for the
> DevOps issuer/subject it shows you. No secret to rotate.

---

## 3. Create the pipeline environment + pipeline

- Pipelines → **Environments** → New → **`bcmcp-dev`** (matches the `environment:`
  in the YAML; lets you add approvals later).
- Pipelines → **New pipeline** → Azure Repos Git → this repo → **Existing
  Azure Pipelines YAML file** → `/azure-pipelines.yml`.

---

## 4. First deploy order

1. **Run the pipeline** with both parameters **false** (default). This:
   provisions infra (Phase A), builds the image in ACR, and deploys the app
   from ACR — no domain binding, no KV secrets yet.
2. **Push secrets to Key Vault** (one time) — see `infra/README.md`
   (`MCP-ENCRYPTION-KEY` must match the legacy server, plus `BC-CLIENT-SECRET`
   and `SETUP-CLIENT-SECRET`).
3. Wait for the managed cert to reach **Succeeded** (DNS propagation):
   ```bash
   az containerapp env certificate list -g BCmcp-rg --name bcmcp-cae-dev -o table
   ```
4. **Re-run the pipeline** with `wireKeyVaultSecrets=true` and
   `enableCustomDomainBinding=true` to finish Phase B.

---

## Quick checklist

- [ ] SP created in Tenant B with Contributor + RBAC Administrator (or Owner)
- [ ] DNS Zone Contributor on `origo-dns-rg` (if different subscription)
- [ ] Manual AzureRM service connection `bcmcp-tenantB-arm` (Tenant B ids)
- [ ] DevOps environment `bcmcp-dev` created
- [ ] Pipeline created from `azure-pipelines.yml`
- [ ] First run (flags false) → push KV secrets → cert Succeeded → re-run (flags true)
