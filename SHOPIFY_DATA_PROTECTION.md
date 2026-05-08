# Shopify Data Protection Questionnaire Answers

This document contains the answers submitted to Shopify for the **Protected Customer Data** access request for the PrintDock app. 

Since PrintDock relies on Firebase and Google Cloud Platform (GCP), many of these security features are handled automatically by the infrastructure.

## Purpose
Personal data is information that can identify a unique person, like name, or be linked back to a unique person, like an order total or customer ID.

* **Do you process the minimum personal data required to provide value to merchants?**
  * **Yes**
* **Do you tell merchants the personal data that you process and your purposes for processing it?**
  * **Yes** (Will be covered in the app's Privacy Policy).
* **Do you limit your use of personal data to that purpose?**
  * **Yes**

## Consent
* **Do you have privacy and data protection agreements with your merchants?**
  * **Yes** (Will be covered in the Terms of Service/Privacy Policy).
* **Do you respect and apply customers’ consent decisions?**
  * **Yes**
* **Do you respect and apply customers’ decisions to opt-out of having their data sold?**
  * **Yes**
* **If you use personal data for automated decision-making and those decisions may have legal or significant effects, can customers opt-out?**
  * **Not applicable** (PrintDock does not perform automated legal decision making).

## Storage
* **Do you have retention periods that make sure personal data isn’t kept longer than needed?**
  * **Yes** (Firestore TTL policies can be configured to delete old orders).
* **Do you encrypt data at rest and in transit?**
  * **Yes** (Google Firebase encrypts data at rest and in transit by default).
* **Do you encrypt your data backups?**
  * **Yes** (Google Cloud handles this automatically).
* **Do you separate test and production data?**
  * **Yes** (Development uses specific test stores).
* **Do you have a data loss prevention strategy?**
  * **Yes**

## Access
* **Do you limit staff access to customers’ personal data?**
  * **Yes** (Access is restricted to authorized Firebase/GCP administrators).
* **Do you have strong password requirements for staff passwords?**
  * **Yes** (Enforced via Google/Workspace accounts).
* **Do you log access to personal data?**
  * **Yes** (Via Google Cloud Audit Logs).
* **Do you have a security incident response policy?**
  * **Yes**

## Audits and certifications
* **If your app has received any third-party security audits or certifications, list the type and date:**
  * Left blank (or "None currently, relying on Google Cloud Platform SOC2 compliance").