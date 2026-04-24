import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

const FEATURES = [
  {
    title: "Artwork uploads, built for print",
    description:
      "A storefront block your customers can drag and drop into. Supports images and PDFs with client-side + server-side validation so only print-ready files reach your production queue.",
    icon: "upload",
  },
  {
    title: "Automatic file validation",
    description:
      "Enforce file type, size, dimensions, DPI, and page count. Warn shoppers about low-resolution art, or block add-to-cart entirely when the file cannot be printed as ordered.",
    icon: "shield",
  },
  {
    title: "Dynamic pricing that scales",
    description:
      "Charge per file, per inch of height, per square inch, or a flat upload fee. PrintDock computes the price from the uploaded artwork and applies it to checkout via a Shopify Cart Transform function.",
    icon: "price",
  },
  {
    title: "Order jobs with print-ready files",
    description:
      "Every order becomes a job in your dashboard with the renamed, production-ready file, validation warnings, audit history, status workflow, and CSV export.",
    icon: "jobs",
  },
  {
    title: "Target by product or collection",
    description:
      "Attach upload fields to specific products, variants, or entire collections. Different rules per product type — different pricing for posters, banners, business cards.",
    icon: "target",
  },
  {
    title: "Built on Shopify primitives",
    description:
      "App Proxy, Theme App Blocks, Cart Transform functions, and a managed-pricing billing plan. No hacks — everything works with checkout, discounts, taxes, and Shop Pay.",
    icon: "shopify",
  },
];

const PLANS = [
  {
    name: "Free",
    tagline: "Try it on a live store",
    features: [
      "Up to 2 upload fields",
      "Basic file-type & size validation",
      "50 MB per file, 500 MB total storage",
      "7-day file retention",
    ],
  },
  {
    name: "Starter",
    tagline: "For growing print shops",
    features: [
      "Unlimited upload fields",
      "Advanced validation (DPI, dimensions, page count)",
      "300 MB per file, 15 GB total storage",
      "Custom file renaming patterns",
    ],
  },
  {
    name: "Pro",
    tagline: "Dynamic pricing unlocked",
    highlighted: true,
    features: [
      "Everything in Starter",
      "Dynamic pricing (per-inch, per-sq-inch, per-file, flat)",
      "1 GB per file, 30 GB total storage",
      "30-day file retention",
    ],
  },
  {
    name: "Business",
    tagline: "High-volume production",
    features: [
      "Everything in Pro",
      "5 GB per file, 75 GB total storage",
      "Priority support",
      "30-day file retention",
    ],
  },
];

function FeatureIcon({ name }: { name: string }) {
  const common = { width: 28, height: 28, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "upload":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M12 16V4M6 10l6-6 6 6M4 20h16" />
        </svg>
      );
    case "shield":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case "price":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M20 12l-8 8-9-9V3h8l9 9z" />
          <circle cx="7.5" cy="7.5" r="1.5" />
        </svg>
      );
    case "jobs":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9h10M7 13h10M7 17h6" />
        </svg>
      );
    case "target":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.5" />
        </svg>
      );
    case "shopify":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M4 7l8-3 8 3v10l-8 3-8-3V7z" />
          <path d="M4 7l8 3 8-3M12 10v10" />
        </svg>
      );
    default:
      return null;
  }
}

export default function LandingPage() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a className={styles.brand} href="#top">
            <span className={styles.brandMark} aria-hidden>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l8 3v12l-8 3-8-3V6l8-3z" />
                <path d="M8 10v5l4 1.5L16 15v-5" />
              </svg>
            </span>
            PrintDock
          </a>
          <nav className={styles.nav}>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#plans">Plans</a>
            <a className={styles.navCta} href="#login">Log in</a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <span className={styles.eyebrow}>Shopify app for print shops</span>
              <h1 className={styles.heroHeading}>
                Accept print-ready artwork.<br />
                Price it automatically.<br />
                Fulfill with confidence.
              </h1>
              <p className={styles.heroSub}>
                PrintDock adds a powerful artwork-upload and dynamic-pricing layer to
                your Shopify store. Customers drop their file in, PrintDock validates
                it, calculates the exact price from its dimensions, and hands a
                production-ready job to your team.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.primaryCta} href="#login">
                  Install on your store
                </a>
                <a className={styles.secondaryCta} href="#features">
                  See how it works
                </a>
              </div>
              <ul className={styles.heroBullets}>
                <li>Works with Shopify checkout, discounts, taxes, and Shop Pay</li>
                <li>No code required for merchants — add the theme block and go</li>
                <li>GDPR-compliant file retention built in</li>
              </ul>
            </div>

            <aside id="login" className={styles.loginCard} aria-labelledby="login-heading">
              <h2 id="login-heading" className={styles.loginHeading}>
                Open PrintDock on your store
              </h2>
              <p className={styles.loginSub}>
                Enter your myshopify domain to install or jump back into your dashboard.
              </p>
              {showForm ? (
                <Form className={styles.form} method="post" action="/auth/login">
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Shop domain</span>
                    <input
                      className={styles.input}
                      type="text"
                      name="shop"
                      placeholder="my-shop.myshopify.com"
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                    <span className={styles.fieldHint}>e.g. my-shop-domain.myshopify.com</span>
                  </label>
                  <button className={styles.submit} type="submit">
                    Log in / Install
                  </button>
                </Form>
              ) : (
                <p className={styles.loginSub}>
                  Installation is currently managed by your administrator.
                </p>
              )}
            </aside>
          </div>
        </section>

        <section id="features" className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionHeading}>Everything a print shop needs on Shopify</h2>
            <p className={styles.sectionSub}>
              Built specifically for custom-print merchants. No plugins to stitch together.
            </p>
          </div>
          <div className={styles.featureGrid}>
            {FEATURES.map((feature) => (
              <article key={feature.title} className={styles.featureCard}>
                <span className={styles.featureIcon} aria-hidden>
                  <FeatureIcon name={feature.icon} />
                </span>
                <h3 className={styles.featureTitle}>{feature.title}</h3>
                <p className={styles.featureText}>{feature.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="how" className={styles.sectionAlt}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionHeading}>How it works</h2>
            <p className={styles.sectionSub}>
              From customer upload to fulfilled order in four steps.
            </p>
          </div>
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepNum}>1</span>
              <div>
                <h3 className={styles.stepTitle}>Add the theme block</h3>
                <p className={styles.stepText}>
                  Drop the PrintDock upload block into any product page template. Choose
                  which products or collections it appears on.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.stepNum}>2</span>
              <div>
                <h3 className={styles.stepTitle}>Configure rules & pricing</h3>
                <p className={styles.stepText}>
                  Set allowed file types, dimensions, DPI thresholds, and upload fees
                  — per file, per inch, per square inch, or flat.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.stepNum}>3</span>
              <div>
                <h3 className={styles.stepTitle}>Customer uploads and pays</h3>
                <p className={styles.stepText}>
                  PrintDock validates the artwork, calculates the upload fee from the
                  file itself, and adds it to checkout via Shopify&apos;s Cart Transform.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.stepNum}>4</span>
              <div>
                <h3 className={styles.stepTitle}>Fulfill from the dashboard</h3>
                <p className={styles.stepText}>
                  Orders arrive as jobs with the renamed print-ready file, warnings,
                  notes, and a clean status workflow for your production team.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section id="plans" className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionHeading}>Simple plans that grow with you</h2>
            <p className={styles.sectionSub}>
              Start free. Upgrade when you need advanced validation, bigger files, or
              dynamic pricing.
            </p>
          </div>
          <div className={styles.planGrid}>
            {PLANS.map((plan) => (
              <article
                key={plan.name}
                className={`${styles.planCard} ${plan.highlighted ? styles.planHighlighted : ""}`}
              >
                {plan.highlighted ? (
                  <span className={styles.planBadge}>Most popular</span>
                ) : null}
                <h3 className={styles.planName}>{plan.name}</h3>
                <p className={styles.planTagline}>{plan.tagline}</p>
                <ul className={styles.planList}>
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <p className={styles.planFoot}>
            Billing is handled by Shopify Managed Pricing. Prices shown in your Admin
            when you install the app.
          </p>
        </section>

        <section className={styles.ctaBand}>
          <div className={styles.ctaInner}>
            <h2 className={styles.ctaHeading}>Ready to stop chasing artwork?</h2>
            <p className={styles.ctaSub}>
              Install PrintDock in minutes. No credit card required to start.
            </p>
            <a className={styles.primaryCta} href="#login">
              Install on your store
            </a>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>© {new Date().getFullYear()} PrintDock</span>
          <span className={styles.footerMuted}>
            Built for Shopify · Artwork uploads &amp; dynamic pricing
          </span>
        </div>
      </footer>
    </div>
  );
}
