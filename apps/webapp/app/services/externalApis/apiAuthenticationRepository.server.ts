import type { APIConnection } from ".prisma/client";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { APIStore } from "./apiStore";
import { apiStore as apis } from "./apiStore";
import type { ExternalAPI } from "./types";
import { createOAuth2Url, getClientConfigFromEnv } from "./oauth2.server";
import { env } from "~/env.server";

const ConnectionMetadataSchema = z.object({
  account: z.string().optional(),
});

type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;

export class APIAuthenticationRepository {
  #organizationId: string;
  #apiStore: APIStore;
  #prismaClient: PrismaClient;

  constructor(
    organizationId: string,
    apiStore: APIStore = apis,
    prismaClient: PrismaClient = prisma
  ) {
    this.#organizationId = organizationId;
    this.#apiStore = apiStore;
    this.#prismaClient = prismaClient;
  }

  /** Get all API connections for the organization */
  async getAllConnections() {
    const connections = await this.#prismaClient.aPIConnection.findMany({
      where: {
        organizationId: this.#organizationId,
      },
      select: {
        id: true,
        title: true,
        apiIdentifier: true,
        authenticationMethodKey: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return connections.map((c) => this.#enrichConnection(c));
  }

  /** Get all API connections for the organization, for a specific API */
  async getConnectionsForApi(api: ExternalAPI) {
    const connections = await this.#prismaClient.aPIConnection.findMany({
      where: {
        organizationId: this.#organizationId,
        apiIdentifier: api.identifier,
      },
      select: {
        id: true,
        title: true,
        apiIdentifier: true,
        authenticationMethodKey: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return connections.map((c) => this.#enrichConnection(c));
  }

  async createConnectionAttempt({
    organizationId,
    apiIdentifier,
    authenticationMethodKey,
    scopes,
  }: {
    organizationId: string;
    apiIdentifier: string;
    authenticationMethodKey: string;
    scopes: string[];
  }) {
    const api = this.#apiStore.getApi(apiIdentifier);
    if (!api) {
      throw new Error(`API ${apiIdentifier} not found`);
    }

    const authenticationMethod =
      api.authenticationMethods[authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${authenticationMethodKey} not found for API ${apiIdentifier}`
      );
    }

    switch (authenticationMethod.type) {
      case "oauth2": {
        //create a connection attempt
        const connectionAttempt =
          await this.#prismaClient.aPIConnectionAttempt.create({
            data: {
              organizationId,
              apiIdentifier,
              authenticationMethodKey,
              scopes,
            },
          });

        //create a url for the oauth2 flow
        const getClientConfig = getClientConfigFromEnv(
          authenticationMethod.client.id.envName,
          authenticationMethod.client.secret.envName
        );
        const createAuthorizationParams = {
          authorizationUrl: authenticationMethod.config.authorization.url,
          clientId: getClientConfig.id,
          clientSecret: getClientConfig.secret,
          key: connectionAttempt.id,
          callbackUrl: `${env.APP_ORIGIN}/api/v3/oauth2/callback`,
          scopes,
          scopeSeparator:
            authenticationMethod.config.authorization.scopeSeparator,
        };

        const authorizationUrl = await (authenticationMethod.config
          .authorization.createUrl
          ? authenticationMethod.config.authorization.createUrl(
              createAuthorizationParams
            )
          : createOAuth2Url(createAuthorizationParams));
        console.log(authorizationUrl);
      }
      default: {
        throw new Error(
          `Authentication method type ${authenticationMethod.type} not supported`
        );
      }
    }
  }

  /** Get credentials for the given api and id */
  async getCredentials(api: ExternalAPI, connectionId: string) {
    //todo Prisma query for credentials for the given api and id
    //todo retrieve the credential from secret storage and the security provider
    //todo refresh the credential if needed
  }

  #enrichConnection(
    connection: Pick<
      APIConnection,
      | "id"
      | "title"
      | "apiIdentifier"
      | "authenticationMethodKey"
      | "metadata"
      | "createdAt"
      | "updatedAt"
    >
  ) {
    //parse the metadata into the desired format, fallback if needed
    const parsedMetadata = ConnectionMetadataSchema.safeParse(
      connection.metadata
    );
    let metadata: ConnectionMetadata = {};
    if (!parsedMetadata.success) {
      console.error(parsedMetadata.error.format());
      metadata = {};
    }

    //add details about the API and authentication method
    const api = this.#apiStore.getApi(connection.apiIdentifier);
    if (!api) {
      throw new Error(
        `API ${connection.apiIdentifier} not found for connection ${connection.id}`
      );
    }

    const authenticationMethod =
      api.authenticationMethods[connection.authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${connection.authenticationMethodKey} not found for API ${connection.apiIdentifier} for connection ${connection.id}`
      );
    }

    return {
      ...connection,
      metadata,
      api: {
        identifier: api.identifier,
        name: api.name,
      },
      authenticationMethod: {
        type: authenticationMethod.type,
        possibleScopes: authenticationMethod.scopes,
      },
    };
  }
}
