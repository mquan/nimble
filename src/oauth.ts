import crypto from "node:crypto";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { OAuthAuthConfig } from "./config.js";
import type { CredentialStore } from "./credentials.js";

type OAuthStoredClient = OAuthClientInformationMixed;
type OAuthStoredTokens = OAuthTokens;

function buildRef(base: string, suffix: "client" | "tokens" | "verifier"): string {
  return `${base}:${suffix}`;
}

export class StoredOAuthProvider implements OAuthClientProvider {
  private store: CredentialStore;
  private baseRef: string;
  private metadata: OAuthClientMetadata;
  private redirect: string | URL | undefined;

  constructor(store: CredentialStore, config: OAuthAuthConfig) {
    this.store = store;
    this.baseRef = config.credentialRef;
    this.metadata = config.clientMetadata as OAuthClientMetadata;
    this.redirect = config.redirectUrl;
  }

  get redirectUrl(): string | URL | undefined {
    if (this.redirect) {
      return this.redirect;
    }
    const redirectUris = (this.metadata as { redirect_uris?: string[] })
      .redirect_uris;
    return redirectUris?.[0];
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }

  async state(): Promise<string> {
    return crypto.randomBytes(16).toString("hex");
  }

  async clientInformation(): Promise<OAuthStoredClient | undefined> {
    return (
      this.store.getJson<OAuthStoredClient>(buildRef(this.baseRef, "client")) ??
      undefined
    );
  }

  async saveClientInformation(
    clientInformation: OAuthStoredClient,
  ): Promise<void> {
    this.store.setJson(buildRef(this.baseRef, "client"), clientInformation);
  }

  async tokens(): Promise<OAuthStoredTokens | undefined> {
    return (
      this.store.getJson<OAuthStoredTokens>(buildRef(this.baseRef, "tokens")) ??
      undefined
    );
  }

  async saveTokens(tokens: OAuthStoredTokens): Promise<void> {
    this.store.setJson(buildRef(this.baseRef, "tokens"), tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = authorizationUrl.toString();
    if (process.platform === "darwin") {
      const { spawn } = await import("node:child_process");
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      console.log("Opening browser for authorization...");
      return;
    }
    console.log("Open this URL to authorize mini-mcp:");
    console.log(url);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.store.set(buildRef(this.baseRef, "verifier"), codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = this.store.get(buildRef(this.baseRef, "verifier"));
    if (!verifier) {
      throw new Error("Missing OAuth code verifier");
    }
    return verifier;
  }
}
