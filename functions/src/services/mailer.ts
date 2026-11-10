import { defineSecret, defineString } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import nodemailer from "nodemailer";

/** Gmail address and app password used to send feedback emails. */
export const FEEDBACK_SMTP_USER = defineSecret("FEEDBACK_SMTP_USER");
export const FEEDBACK_SMTP_PASS = defineSecret("FEEDBACK_SMTP_PASS");
/** Where feedback emails go. */
export const FEEDBACK_EMAIL_TO = defineString("FEEDBACK_EMAIL_TO");

export const PROD_PROJECT = "tournmate-prod";
export const DEV_PROJECT = "tournmate-dev";

export interface MailMessage {
  subject: string;
  text: string;
  html: string;
}

/** The slice of a nodemailer transport we use (so tests can fake it). */
export interface MailTransport {
  sendMail(msg: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

let injected: { transport: MailTransport; to: string } | null = null;

/** Tests only: send through `transport` to `to`, bypassing secrets and the project check. Pass null to reset. */
export function setMailTransportForTests(transport: MailTransport | null, to = "test@example.com"): void {
  injected = transport ? { transport, to } : null;
}

export function currentProjectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
}

/** "[TournMate]" for prod, "[TournMate dev]" for anything else. */
export function subjectPrefix(projectId = currentProjectId()): string {
  return projectId === PROD_PROJECT ? "[TournMate]" : "[TournMate dev]";
}

/**
 * Sends one email. Returns true if sent. Never throws: failures and
 * unconfigured projects are logged and return false.
 */
export async function sendMail(msg: MailMessage): Promise<boolean> {
  try {
    if (injected) {
      await injected.transport.sendMail({ from: "TournMate", to: injected.to, ...msg });
      return true;
    }
    const projectId = currentProjectId();
    if (projectId !== PROD_PROJECT && projectId !== DEV_PROJECT) {
      logger.info("mailer: skipping, not a dev or prod project", { projectId });
      return false;
    }
    const user = FEEDBACK_SMTP_USER.value();
    const pass = FEEDBACK_SMTP_PASS.value();
    const to = FEEDBACK_EMAIL_TO.value();
    if (!user || !pass || !to) {
      logger.error("mailer: SMTP user, password or recipient not configured");
      return false;
    }
    const transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    await transport.sendMail({ from: `TournMate <${user}>`, to, ...msg });
    return true;
  } catch (e) {
    logger.error("mailer: send failed", e);
    return false;
  }
}
