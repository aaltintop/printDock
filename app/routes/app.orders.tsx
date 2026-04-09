import { data } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import { getSignedDownloadUrl } from "../services/storage.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Fetch order jobs for this shop
  const jobsSnapshot = await db
    .collection("jobs")
    .where("shopDomain", "==", session.shop)
    .get();

  const orders = jobsSnapshot.docs
    .map((doc) => {
      const docData = doc.data();
      return {
        id: doc.id,
        orderId: docData.shopifyOrderId,
        orderName: docData.shopifyOrderName,
        lineItemId: docData.shopifyLineItemId,
        status: docData.status,
        createdAt: docData.createdAt,
        customerEmail: docData.customerEmail,
        shippingAddress: docData.shippingAddress || null,
        asset: docData.assetSnapshot || null,
      };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return data({ orders });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const storagePath = formData.get("storagePath") as string;

  if (!storagePath || !storagePath.startsWith(`uploads/${session.shop}/`)) {
    return data({ error: "Invalid storage path" }, { status: 400 });
  }

  try {
    const downloadUrl = await getSignedDownloadUrl(storagePath);
    return data({ downloadUrl });
  } catch (error) {
    console.error("Error generating download URL:", error);
    return data({ error: "Failed to generate download link" }, { status: 500 });
  }
};

export default function Orders() {
  const { orders } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.data && "downloadUrl" in fetcher.data && fetcher.data.downloadUrl) {
      window.open(fetcher.data.downloadUrl as string, "_blank");
    }
  }, [fetcher.data]);

  const handleDownload = (storagePath: string) => {
    fetcher.submit(
      { storagePath },
      { method: "POST" }
    );
  };

  return (
    <s-page heading="Order Jobs">
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-table>
          <s-table-header-row>
            <s-table-header>Order</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>Address</s-table-header>
            <s-table-header>File</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Date</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {orders.map(({ id, orderName, customerEmail, shippingAddress, status, createdAt, asset }) => {
              const date = new Date(createdAt).toLocaleString();
              
              // Format the address into a readable string
              let addressString = "N/A";
              if (shippingAddress) {
                const parts = [
                  shippingAddress.address1,
                  shippingAddress.address2,
                  shippingAddress.city,
                  shippingAddress.province_code,
                  shippingAddress.zip,
                  shippingAddress.country_code
                ].filter(Boolean);
                addressString = parts.join(", ");
              }
              
              return (
                <s-table-row key={id}>
                  <s-table-cell>
                    <s-text>
                      {orderName || "Unknown"}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>{customerEmail || "N/A"}</s-table-cell>
                  <s-table-cell>{addressString}</s-table-cell>
                  <s-table-cell>{asset?.originalName || "No File"}</s-table-cell>
                  <s-table-cell>{status}</s-table-cell>
                  <s-table-cell>{date}</s-table-cell>
                  <s-table-cell>
                    {asset?.storagePath ? (
                      <s-button
                        onClick={() => handleDownload(asset.storagePath)}
                        {...(fetcher.state === "submitting" && fetcher.formData?.get("storagePath") === asset.storagePath ? { loading: true } : {})}
                      >
                        Download
                      </s-button>
                    ) : (
                      <s-text>N/A</s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-box>
    </s-page>
  );
}
