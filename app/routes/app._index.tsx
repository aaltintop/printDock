import type { LoaderFunctionArgs } from "react-router";
import { useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  const navigate = useNavigate();

  return (
    <s-page heading="PrintDock Dashboard">
      <s-box padding="base">
        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>View Customer Uploads</s-heading>
            <s-paragraph>
              Review files uploaded by your customers directly from the product page. Download artwork to process orders.
            </s-paragraph>
            <s-button onClick={() => navigate("/app/uploads")}>
              Go to Uploads
            </s-button>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>Manage Order Jobs</s-heading>
            <s-paragraph>
              Track completed orders that include uploaded artwork. See the status of each print job.
            </s-paragraph>
            <s-button onClick={() => navigate("/app/orders")}>
              Go to Orders
            </s-button>
          </s-box>
        </s-stack>
      </s-box>
    </s-page>
  );
}
