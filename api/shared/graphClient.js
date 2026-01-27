const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

let graphClient = null;

function getGraphClient() {
    if (graphClient) return graphClient;

    const credential = new ClientSecretCredential(
        process.env.AZURE_TENANT_ID,
        process.env.AZURE_CLIENT_ID,
        process.env.AZURE_CLIENT_SECRET
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default']
    });

    graphClient = Client.initWithMiddleware({ authProvider });
    return graphClient;
}

module.exports = { getGraphClient };
