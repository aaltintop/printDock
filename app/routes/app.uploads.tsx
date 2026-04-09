import { useEffect } from "react";
import { data } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import { getSignedDownloadUrl } from "../services/storage.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Fetch sessions for this shop
  const sessionsSnapshot = await db
    .collection("sessions")
    .where("shopDomain", "==", session.shop)
    .get();

  const uploads = sessionsSnapshot.docs
    .map((doc) => {
      const docData = doc.data();
      return {
        id: doc.id,
        status: docData.status,
        createdAt: docData.expiresAt ? new Date(new Date(docData.expiresAt).getTime() - 2 * 60 * 60 * 1000).toISOString() : new Date().toISOString(),
        asset: docData.asset || null,
        productId: docData.productId,
      };
    })
    .filter((u) => u.asset !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return data({ uploads });
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

export default function Uploads() {
  const { uploads } = useLoaderData<typeof loader>();
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
    <s-page heading="Customer Uploads">
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-table>
          <s-table-header-row>
            <s-table-header>File Name</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Size</s-table-header>
            <s-table-header>Upload Date</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {uploads.map(({ id, status, createdAt, asset }) => {
              const date = new Date(createdAt).toLocaleString();
              const sizeMB = asset?.sizeBytes ? (asset.sizeBytes / (1024 * 1024)).toFixed(2) + " MB" : "N/A";
              
              return (
                <s-table-row key={id}>
                  <s-table-cell>
                    <s-text>
                      {asset?.originalName || "Unknown"}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>{status}</s-table-cell>
                  <s-table-cell>{sizeMB}</s-table-cell>
                  <s-table-cell>{date}</s-table-cell>
                  <s-table-cell>
                    <s-button
                      onClick={() => handleDownload(asset.storagePath)}
                      {...(fetcher.state === "submitting" && fetcher.formData?.get("storagePath") === asset.storagePath ? { loading: true } : {})}
                    >
                      Download
                    </s-button>
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
