import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { FEEDBACK_SMTP_PASS, FEEDBACK_SMTP_USER } from "../services/mailer";
import { sendRatingReportDigest } from "../services/ratingReportEmails";

/** 08:05 Chicago: one email with the last 24h of review reports (nothing if none). */
export const ratingReportDigest = onSchedule(
  { schedule: "every day 08:05", timeZone: "America/Chicago", region: "us-central1",
    secrets: [FEEDBACK_SMTP_USER, FEEDBACK_SMTP_PASS] },
  async () => {
    try {
      const n = await sendRatingReportDigest(getFirestore(), new Date());
      logger.info("rating report digest", { reports: n });
    } catch (e) {
      logger.error("rating report digest failed", e);
    }
  });
