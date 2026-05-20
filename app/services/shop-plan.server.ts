type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const SHOP_PLAN_QUERY = `#graphql
  query PrintDockShopPlan {
    shop {
      plan {
        partnerDevelopment
      }
    }
  }
`;

/** True when the shop is a Partner development store (non-billable for paid public plans). */
export async function isPartnerDevelopmentStore(admin: AdminLike): Promise<boolean> {
  const response = await admin.graphql(SHOP_PLAN_QUERY);
  const json = (await response.json()) as {
    data?: { shop?: { plan?: { partnerDevelopment?: unknown } } };
  };
  return json.data?.shop?.plan?.partnerDevelopment === true;
}
