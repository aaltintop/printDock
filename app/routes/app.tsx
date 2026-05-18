import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import {
  isAppSetupComplete,
  isPathExemptFromSetupRedirect,
} from "../services/app-setup-status.server";
import {
  getEffectiveBillingPlan,
  reconcileBillingPlanFromShopifySubscriptions,
} from "../services/shop-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { admin, session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    const currentUrl = new URL(request.url);
    const path = currentUrl.pathname;
    log.event("admin_page_view", { path });

    if (session.shop && !isPathExemptFromSetupRedirect(path)) {
      const setupComplete = await isAppSetupComplete(admin, session.shop);
      if (!setupComplete) {
        // Preserve the embedded-app query string (`embedded`, `host`, `shop`,
        // `id_token`, `hmac`, etc). Stripping it forces the next request to
        // `/app/onboarding` to authenticate without any shop hint, which makes
        // `authenticate.admin()` bounce to `/auth/login` and shows the public
        // shop-domain form inside the admin iframe.
        const onboardingUrl = new URL(`/app/onboarding${currentUrl.search}`, currentUrl.origin);
        onboardingUrl.searchParams.set("returnTo", `${path}${currentUrl.search}`);
        throw redirect(`${onboardingUrl.pathname}${onboardingUrl.search}`);
      }
    }

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

    if (session.shop) {
      try {
        await reconcileBillingPlanFromShopifySubscriptions(
          session.shop,
          appInstallation?.activeSubscriptions,
        );
      } catch (reconcileErr) {
        log.error("billing_reconcile_failed", reconcileErr, { shopDomain: session.shop });
      }

      const billingAfter = await getEffectiveBillingPlan(session.shop);
      const subs = appInstallation?.activeSubscriptions ?? [];
      const hasShopifyActiveRow = subs.some((s: { status?: string }) => {
        const st = String(s?.status ?? "")
          .trim()
          .toUpperCase();
        return st === "ACTIVE" || st === "ACCEPTED";
      });
      const billingStatus =
        hasShopifyActiveRow ||
        (billingAfter.status === "active" && billingAfter.planCode !== "free")
          ? "active"
          : "trial";

      await db.collection("shops").doc(session.shop).set(
        {
          accessToken: session.accessToken,
          installedAt: new Date().toISOString(),
          billingStatus,
          scopes:
            appInstallation?.accessScopes?.map((scope: { handle?: string }) => scope.handle) || [],
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
  type PolarisLinkProps = {
    url?: string;
    external?: boolean;
    children?: ReactNode;
  } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

  const PolarisLink = ({ url, external, children, ...rest }: PolarisLinkProps) => {
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
        <ui-nav-menu>
          <a href="/app" rel="home">Dashboard</a>
          <a href="/app/onboarding">Setup</a>
          <a href="/app/fields">Fields</a>
          <a href="/app/orders">Orders</a>
          <a href="/app/plans">Plans</a>
          <a href="/app/release-notes">Release notes</a>
        </ui-nav-menu>
        <Outlet />
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

  console.error(
    JSON.stringify({
      severity: "ERROR",
      event: "admin_error_boundary",
      surface: typeof window === "undefined" ? "ssr" : "client",
      message,
      stack,
      timestamp: new Date().toISOString(),
      route: "/app",
    }),
  );
  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
