export type FieldDimensionType =
  | "widthPx"
  | "heightPx"
  | "dpi"
  | "widthInch"
  | "heightInch"
  | "pageCount"
  | "fileSizeMB";

export type FieldOperator = "gt" | "lt" | "eq" | "gte" | "lte";
export type FieldRuleAction = "warning" | "prevent";
export type QuantityMode = "per_file" | "product_quantity";
export type PricingUnitType = "inch_height" | "inch_square" | "per_file" | "flat";

export interface UploadFieldDimensionRule {
  id: string;
  dimensionType: FieldDimensionType;
  operator: FieldOperator;
  value: number;
  action: FieldRuleAction;
  warningMessage: string;
  roundingEnabled?: boolean;
  applyToVariantIds?: string[];
}

export interface UploadFieldPricing {
  enabled: boolean;
  unitType: PricingUnitType;
  unitPrice: number;
  minPrice: number;
  dpi: number;
  printWidth: number;
  roundingEnabled: boolean;
}

export interface UploadFieldConfig {
  id: string;
  productId: string;
  productHandle: string;
  targetVariantIds: string[];
  isActive: boolean;
  isRequired: boolean;
  adminTitle: string;
  storefrontTitle: string;
  storefrontDescription: string;
  fileRenamingPattern: string;
  minFiles: number;
  maxFiles: number;
  allowedExtensions: string[];
  maxFileMB: number;
  fileQuantityManagement: {
    enabled: boolean;
    mode: QuantityMode;
  };
  pricing: UploadFieldPricing;
  dimensionRules: UploadFieldDimensionRule[];
  planRequirement: "free" | "basic_plus" | "pro_plus";
  createdAt: string;
  updatedAt: string;
}

export interface UploadAsset {
  id: string;
  storagePath: string;
  originalName: string;
  mimeType: string;
  fileExtension: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  dpi: number | null;
  widthInch: number | null;
  heightInch: number | null;
  pageCount: number | null;
  validationResults: Array<{
    ruleId: string;
    severity: "blocking" | "warning";
    message: string;
    actual: number | null;
    expected: number;
  }>;
  pricing: {
    filePrice: number;
    total: number;
    explanation: string;
    currency: string;
  } | null;
  blocked: boolean;
}

export interface UploadSession {
  id: string;
  shopDomain: string;
  productId: string;
  variantId: string;
  fieldId: string | null;
  status: "active" | "success" | "blocked" | "converted" | "expired";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  asset: UploadAsset | null;
  assets: UploadAsset[];
}

export interface OrderJob {
  id: string;
  shopDomain: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyLineItemId: string;
  sessionId: string;
  shippingAddress: Record<string, unknown> | null;
  productId: string;
  variantId: string;
  assetSnapshot: UploadAsset | null;
  /** Pre-rename upload path; used to resolve Print Ready links after copy to orders/… */
  legacySessionUploadPath?: string;
  lineItemPropsSnapshot: Array<{ name: string; value: string }>;
  calculatedPrice: number;
  warnings: string[];
  status: string;
  assignee: string | null;
  internalNotes: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderJobAuditEvent {
  id: string;
  eventType: string;
  message: string;
  metadata: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

export interface AppSettings {
  language: string;
  stylePreset: "minimal" | "high_contrast";
  requireThemeBlock: boolean;
  uploadRetentionDays: number;
  defaultOrderStatus: string;
  csvDelimiter: "," | ";";
  autoAssignEnabled: boolean;
  autoAssignEmailDomain: string;
  updatedAt: string;
}

export interface BillingPlan {
  planCode: "free" | "basic_plus" | "pro_plus";
  status: "active" | "inactive" | "trial";
  subscriptionId: string | null;
  monthlyUploadsLimit: number;
  maxFileMBLimit: number;
  allowAdvancedRules: boolean;
  allowAutoPricing: boolean;
  usageThisMonth: number;
  usageMonthKey: string;
  updatedAt: string;
}

export interface DashboardStats {
  totalUploads: number;
  totalOrders: number;
  blockedUploads: number;
  estimatedConversionRate: number;
  storageUsedMB: number;
}

