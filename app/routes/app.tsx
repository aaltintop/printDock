import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider, Frame } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { admin, session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    const path = new URL(request.url).pathname;
    log.event("admin_page_view", { path });

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
      await db.collection("shops").doc(session.shop).set(
        {
          accessToken: session.accessToken,
          installedAt: new Date().toISOString(),
          billingStatus:
            appInstallation?.activeSubscriptions?.length > 0 ? "active" : "trial",
          scopes: appInstallation?.accessScopes?.map((s: any) => s.handle) || [],
        },
        { merge: true },
      );
    }

    // eslint-disable-next-line no-undef
    return { apiKey: process.env.SHOPIFY_API_KEY || "" };
  });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  const PolarisLink = ({ url, external, children, ...rest }: any) => {
    if (external || typeof url !== "string") {
      return (
        <a href={url} {...rest}>
          {children}
        </a>
      );
    }

    return (
      <Link to={url} {...rest}>
        {children}
      </Link>
    );
  };

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations} linkComponent={PolarisLink}>
        <Frame>
          <s-app-nav>
            <s-link href="/app/onboarding">Setup</s-link>
            <s-link href="/app">Dashboard</s-link>
            <s-link href="/app/fields">Fields</s-link>
            <s-link href="/app/orders">Orders</s-link>
            <s-link href="/app/plans">Plans</s-link>
          </s-app-nav>
          <Outlet />
        </Frame>
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  if (typeof window === "undefined") {
    const err = error instanceof Error ? error : new Error(message);
    log.error("admin_error_boundary", err, { route: "/app" });
  } else {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        event: "admin_error_boundary",
        message,
        stack,
        timestamp: new Date().toISOString(),
        note:
          "Client-side admin errors appear here in DevTools; SSR uses app/lib/logger.server.ts (Cloud Logging).",
      }),
    );
  }
  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
