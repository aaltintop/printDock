import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Query currentAppInstallation for scopes and active subscriptions
  const response = await admin.graphql(`
    #graphql
    query {
      currentAppInstallation {
        id
        activeSubscriptions {
          id
          name
          status
        }
        accessScopes {
          handle
        }
      }
    }
  `);

  const data = await response.json();
  const appInstallation = data.data?.currentAppInstallation;

  // Persist shop details to Firestore
  if (session.shop) {
    await db.collection("shops").doc(session.shop).set({
      accessToken: session.accessToken,
      installedAt: new Date().toISOString(),
      billingStatus: appInstallation?.activeSubscriptions?.length > 0 ? "active" : "trial",
      scopes: appInstallation?.accessScopes?.map((s: any) => s.handle) || [],
    }, { merge: true });
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/uploads">Uploads</s-link>
        <s-link href="/app/orders">Orders</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
