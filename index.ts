import * as pulumi from "@pulumi/pulumi";
import * as storage from "@pulumi/azure-native/storage";
import * as app from "@pulumi/azure-native/app";
import * as operationalinsights from "@pulumi/azure-native/operationalinsights";
import * as resources from "@pulumi/azure-native/resources";
import * as mongodbatlas from "@pulumi/mongodbatlas";

const cfg = new pulumi.Config();
const dbPass = cfg.getSecret("dbUserPassword");
if (!dbPass) throw "dbUserPassword secret is missing!";

const resourceGroup = new resources.ResourceGroup("openblocks", {
  location: "WestEurope",
});

const atlasProject = new mongodbatlas.Project("atlas-project", {
  orgId: "63cbe6867487fc279b612557",
  name: "openblocks",
});

const atlasCluster = new mongodbatlas.Cluster("atlas-cluster", {
  name: "openblocks",
  backingProviderName: "AZURE",
  projectId: atlasProject.id,
  providerInstanceSizeName: "M0",
  providerName: "TENANT",
  providerRegionName: "EUROPE_WEST",
});

const atlasUser = new mongodbatlas.DatabaseUser("atlas-user", {
  username: "openblocks",
  projectId: atlasProject.id,
  roles: [{ roleName: "atlasAdmin", databaseName: "admin" }],
  authDatabaseName: "admin",
  password: dbPass,
});

const dbaddress = atlasCluster.connectionStrings.apply((c) =>
  c[0].standardSrv.replace("mongodb+srv://", "")
);
const dbConnString = pulumi.interpolate`mongodb+srv://${atlasUser.username}:${dbPass}@${dbaddress}/${atlasCluster.name}?retryWrites=true&w=majority`;

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
    secrets: [{ name: "mongo-uri", value: dbConnString }],
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
        env: [{ name: "MONGODB_URI", secretRef: "mongo-uri" }],
      },
    ],
    scale: {
      minReplicas: 0,
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

new mongodbatlas.ProjectIpAccessList("azure-managed-k8s", {
  projectId: atlasProject.id,
  ipAddress: containerApp.outboundIpAddresses[0],
});

export const url = pulumi.interpolate`https://${containerApp.configuration.apply(
  (c) => (c && c.ingress ? c.ingress.fqdn : undefined)
)}`;
