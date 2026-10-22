import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type AuthenticationResult,
} from "@azure/msal-browser";

export const environment = {
  clientId: process.env.NEXT_PUBLIC_ENTRA_CLIENT_ID,
  tenantId: process.env.NEXT_PUBLIC_ENTRA_TENANT_ID,
  scope: process.env.NEXT_PUBLIC_ENTRA_API_SCOPE,
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, ""),
};

export const configured = Boolean(environment.clientId && environment.tenantId && environment.scope);
let application: Promise<PublicClientApplication> | undefined;
let interaction: Promise<AuthenticationResult> | undefined;

export function getAuth() {
  if (!application) {
    application = (async () => {
      const instance = new PublicClientApplication({
        auth: {
          clientId: environment.clientId!,
          authority: `https://login.microsoftonline.com/${environment.tenantId}`,
          redirectUri: process.env.NEXT_PUBLIC_ENTRA_REDIRECT_URI || window.location.origin,
        },
        cache: { cacheLocation: "sessionStorage" },
      });
      await instance.initialize();
      return instance;
    })().catch(error => {
      application = undefined;
      throw error;
    });
  }
  return application;
}

export async function apiRequest(account: AccountInfo, path: string, options: RequestInit = {}) {
  const auth = await getAuth();
  const request = { scopes: [environment.scope!], account };
  let result: AuthenticationResult;
  try {
    result = await auth.acquireTokenSilent(request);
  } catch (error) {
    if (!(error instanceof InteractionRequiredAuthError)) throw error;
    if (!interaction) {
      interaction = auth.acquireTokenPopup(request).finally(() => { interaction = undefined; });
    }
    result = await interaction;
  }
  if (result.account?.homeAccountId !== account.homeAccountId) {
    throw new Error("Your Microsoft account changed. Sign out and sign in again.");
  }
  const headers = new Headers(options.headers);
  headers.set("Authorization", "Bearer " + result.accessToken);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${environment.apiUrl}${path}`, { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const data = JSON.parse(text);
      message = typeof data.error === "string" ? data.error : data.error?.message || data.message || text;
    } catch { /* Non-JSON errors still get a readable fallback. */ }
    throw new Error(message && message.length < 400 ? message : `Request failed (${response.status}). Please try again.`);
  }
  return response;
}
