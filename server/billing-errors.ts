import Stripe from "stripe";

// Never expose Stripe messages: they can contain customer data or credentials.
export function billingFailure(error: Error) {
  let code = "BILLING_INTERNAL";
  const token = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z0-9_.[\]-]{1,120}$/.test(value)
      ? value : undefined;
  const details: Record<string, unknown> = {};
  if (error instanceof Stripe.errors.StripeError) {
    details.type = token(error.type);
    details.stripeCode = token(error.code);
    details.parameter = token(error.param);
    details.stripeRequestId = token(error.requestId);
    details.status = error.statusCode;
    code = "BILLING_STRIPE_REQUEST";
    if (error.type === "StripeAuthenticationError") code = "BILLING_STRIPE_KEY";
    else if (error.type === "StripePermissionError") code = "BILLING_STRIPE_PERMISSION";
    else if (error.type === "StripeConnectionError") code = "BILLING_STRIPE_CONNECTION";
    else if (error.type === "StripeRateLimitError") code = "BILLING_STRIPE_RATE_LIMIT";
    else if (error.code === "resource_missing") {
      code = error.param === "customer" ? "BILLING_CUSTOMER_ACCOUNT"
        : error.param === "price" || error.param === "line_items[0][price]"
          ? "BILLING_PRICE_ACCOUNT" : "BILLING_STRIPE_RESOURCE";
    } else if (/tax/i.test(error.param || "") || /tax.*(settings|registration|origin address)|head office/i.test(error.message)) {
      code = "BILLING_TAX_SETUP";
    } else if (/configuration/i.test(error.param || "") || /portal.*configuration|configuration.*portal/i.test(error.message)) {
      code = "BILLING_PORTAL_SETUP";
    } else if (error.param === "expires_at") code = "BILLING_CHECKOUT_EXPIRY";
    else if (error.type === "StripeIdempotencyError") code = "BILLING_CHECKOUT_RETRY";
  } else if (/no such table|no such column/i.test(error.message)) {
    code = "BILLING_DB_SCHEMA";
  } else if (/D1_ERROR|SQLITE_/i.test(error.message)) {
    code = "BILLING_DB_ERROR";
  }
  const reference = crypto.randomUUID();
  console.error("Billing request failed", { code, reference, ...details });
  return {
    error: `Payments could not be opened. Please contact support with code ${code} and reference ${reference}.`,
    code,
    reference,
  };
}
