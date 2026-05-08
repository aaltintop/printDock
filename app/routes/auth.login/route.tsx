import { AppProvider } from "@shopify/shopify-app-react-router/react";
import {
  AppProvider as PolarisAppProvider,
  BlockStack,
  Button,
  Card,
  Frame,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <PolarisAppProvider i18n={enTranslations}>
        <Frame>
          <Page title="Log in">
            <Card>
              <Form method="post">
                <BlockStack gap="400">
                  <Text as="p" variant="headingLg">
                    PrintDock
                  </Text>
                  <TextField
                    name="shop"
                    label="Shop domain"
                    helpText="example.myshopify.com"
                    value={shop}
                    onChange={setShop}
                    autoComplete="on"
                    error={errors.shop}
                  />
                  <Button submit variant="primary">
                    Log in
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Page>
        </Frame>
      </PolarisAppProvider>
    </AppProvider>
  );
}
