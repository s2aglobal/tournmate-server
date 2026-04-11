import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions/v2";

/**
 * Sends a push notification to an FCM topic.
 * Topic naming: `region_{countryCode}_{postalCode}`
 */
export async function sendToRegionTopic(
  countryCode: string,
  postalCode: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const topic = `region_${countryCode}_${postalCode}`;
  try {
    await getMessaging().send({
      topic,
      notification: { title, body },
      data: data ?? {},
      apns: {
        payload: {
          aps: { sound: "default", badge: 1 },
        },
      },
    });
    logger.info(`Notification sent to topic: ${topic}`);
  } catch (err) {
    logger.error(`Failed to send to topic ${topic}:`, err);
  }
}

/**
 * Sends a push notification directly to a player's device via FCM token.
 */
export async function sendToPlayer(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  try {
    await getMessaging().send({
      token: fcmToken,
      notification: { title, body },
      data: data ?? {},
      apns: {
        payload: {
          aps: { sound: "default", badge: 1 },
        },
      },
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (
      code === "messaging/invalid-registration-token" ||
      code === "messaging/registration-token-not-registered"
    ) {
      logger.warn(`Stale FCM token, should clean up: ${fcmToken.slice(0, 10)}...`);
    } else {
      logger.error("Failed to send notification:", err);
    }
  }
}
