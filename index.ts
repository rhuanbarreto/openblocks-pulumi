import * as pulumi from "@pulumi/pulumi";
import * as storage from "@pulumi/azure-native/storage";
import * as app from "@pulumi/azure-native/app";
import * as operationalinsights from "@pulumi/azure-native/operationalinsights";
import * as resources from "@pulumi/azure-native/resources";
import * as cosmos from "@pulumi/azure-native/documentdb";

const resourceGroup = new resources.ResourceGroup("openblocks", {
  location: "WestEurope",
});

// Cosmos DB Account
const cosmosdbAccount = new cosmos.DatabaseAccount("openblocks", {
  resourceGroupName: resourceGroup.name,
  databaseAccountOfferType: cosmos.DatabaseAccountOfferType.Standard,
  kind: cosmos.DatabaseAccountKind.MongoDB,
  enableFreeTier: true,
  locations: [
    {
      locationName: resourceGroup.location,
      failoverPriority: 0,
    },
  ],
  consistencyPolicy: {
    defaultConsistencyLevel: cosmos.DefaultConsistencyLevel.Session,
  },
});

const dbConnString = cosmos
  .listDatabaseAccountConnectionStringsOutput({
    accountName: cosmosdbAccount.name,
    resourceGroupName: resourceGroup.name,
  })
  .apply(({ connectionStrings }) => {
    if (!connectionStrings) throw "No connection strings!";
    return connectionStrings[0].connectionString;
  });

const storageAccount = new storage.StorageAccount("storage", {
  resourceGroupName: resourceGroup.name,
  largeFileSharesState: storage.LargeFileSharesState.Enabled,
  kind: storage.Kind.StorageV2,
  sku: { name: storage.SkuName.Standard_LRS },
});

const fileShare = new storage.FileShare("openblocks-file-share", {
  resourceGroupName: resourceGroup.name,
  accountName: storageAccount.name,
  enabledProtocols: storage.EnabledProtocols.SMB,
});

const workspace = new operationalinsights.Workspace("openblocks", {
  resourceGroupName: resourceGroup.name,
  sku: {
    name: operationalinsights.WorkspaceSkuNameEnum.PerGB2018,
  },
  retentionInDays: 30,
});

const workspaceSharedKeys = operationalinsights.getSharedKeysOutput({
  resourceGroupName: resourceGroup.name,
  workspaceName: workspace.name,
});

const managedEnv = new app.ManagedEnvironment("openblocks-container-env", {
  resourceGroupName: resourceGroup.name,
  appLogsConfiguration: {
    destination: "log-analytics",
    logAnalyticsConfiguration: {
      customerId: workspace.customerId,
      sharedKey: workspaceSharedKeys.apply(
        (r: operationalinsights.GetSharedKeysResult) => r.primarySharedKey!
      ),
    },
  },
});

const managedEnvStorage = new app.ManagedEnvironmentsStorage(
  "openblocks-container-env-storage",
  {
    resourceGroupName: resourceGroup.name,
    environmentName: managedEnv.name,
    properties: {
      azureFile: {
        accessMode: app.AccessMode.ReadWrite,
        accountKey: storage.listStorageAccountKeysOutput({
          accountName: storageAccount.name,
          resourceGroupName: resourceGroup.name,
        }).keys[0].value,
        accountName: storageAccount.name,
        shareName: fileShare.name,
      },
    },
    storageName: "openblocks-storage",
  }
);

const containerApp = new app.ContainerApp("openblocks-app", {
  containerAppName: "openblocks",
  resourceGroupName: resourceGroup.name,
  managedEnvironmentId: managedEnv.id,
  configuration: {
    ingress: {
      external: true,
      targetPort: 3000,
    },
    secrets: [{ name: "MONGODB_URI", value: dbConnString }],
  },
  template: {
    containers: [
      {
        name: "openblocks",
        image: "openblocksdev/openblocks-ce",
        resources: {
          cpu: 0.5,
          memory: "1Gi",
        },
        volumeMounts: [
          {
            mountPath: "/openblocks-stacks",
            volumeName: "openblocks-volume",
          },
        ],
        env: [
          { name: "MONGODB_URI", secretRef: "MONGODB_URI" },
          { name: "LOCAL_USER_ID", value: "10010" },
        ],
      },
    ],
    scale: {
      minReplicas: 1,
      maxReplicas: 1,
    },
    volumes: [
      {
        name: "openblocks-volume",
        storageType: app.StorageType.AzureFile,
        storageName: managedEnvStorage.name,
      },
    ],
  },
});

export const url = pulumi.interpolate`https://${containerApp.configuration.apply(
  (c) => (c && c.ingress ? c.ingress.fqdn : undefined)
)}`;
