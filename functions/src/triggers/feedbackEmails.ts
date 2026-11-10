import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { FEEDBACK_SMTP_PASS, FEEDBACK_SMTP_USER } from "../services/mailer";
import { alertOnFeedback, sendFeedbackDigest } from "../services/feedbackEmails";

const secrets = [FEEDBACK_SMTP_USER, FEEDBACK_SMTP_PASS];

/** Immediate email for low-mood feedback (mood 1-2). */
export const onFeedbackCreated = onDocumentCreated(
  { document: "feedback/{id}", region: "us-central1", secrets },
  async (event) => {
    await alertOnFeedback(getFirestore(), event.params.id);
  });

/** 08:00 Chicago: one email summarising the last 24h of feedback (nothing if none). */
export const feedbackDailyDigest = onSchedule(
  { schedule: "every day 08:00", timeZone: "America/Chicago", region: "us-central1", secrets },
  async () => {
    try {
      const n = await sendFeedbackDigest(getFirestore(), new Date());
      logger.info("feedback digest", { entries: n });
    } catch (e) {
      logger.error("feedback digest failed", e);
    }
  });
