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
      android: { priority: "high" as const },
    });
    logger.info(`Notification sent to topic: ${topic}`);
  } catch (err) {
    logger.error(`Failed to send to topic ${topic}:`, err);
  }
}

/**
 * Sends a push notification to a regional topic, excluding a specific user.
 * Uses FCM condition: subscribed to region topic AND NOT to user's personal topic.
 */
export async function sendToRegionTopicExcluding(
  countryCode: string,
  postalCode: string,
  excludeUid: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const regionTopic = `region_${countryCode}_${postalCode}`;

  if (!excludeUid) {
    return sendToRegionTopic(countryCode, postalCode, title, body, data);
  }

  const userTopic = `user_${excludeUid}`;
  const condition = `'${regionTopic}' in topics && !('${userTopic}' in topics)`;

  try {
    await getMessaging().send({
      condition,
      notification: { title, body },
      data: data ?? {},
      apns: {
        payload: {
          aps: { sound: "default", badge: 1 },
        },
      },
      android: { priority: "high" as const },
    });
    logger.info(`Notification sent to ${regionTopic} excluding ${excludeUid}`);
  } catch (err) {
    logger.error(`Failed to send to ${regionTopic} excluding ${excludeUid}:`, err);
  }
}

/**
 * Sends a push notification to the country-wide topic, excluding users
 * already subscribed to the specific regional topic (avoids duplicates).
 * Topic naming: `country_{countryCode}`
 */
export async function sendToCountryTopic(
  countryCode: string,
  postalCode: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const countryTopic = `country_${countryCode}`;
  const regionTopic = `region_${countryCode}_${postalCode}`;

  try {
    await getMessaging().send({
      condition: `'${countryTopic}' in topics && !('${regionTopic}' in topics)`,
      notification: { title, body },
      data: data ?? {},
      apns: {
        payload: {
          aps: { sound: "default", badge: 1 },
        },
      },
      android: { priority: "high" as const },
    });
    logger.info(`Country notification sent to ${countryTopic} (excluding ${regionTopic})`);
  } catch (err) {
    logger.error(`Failed to send to country topic ${countryTopic}:`, err);
  }
}

/**
 * Sends a push notification to the country-wide topic, excluding:
 * 1. Users on the regional topic (avoids duplicates)
 * 2. The creator (avoids self-notification)
 *
 * FCM conditions support up to 5 topics. This uses 3:
 *   country_{cc} AND NOT region_{cc}_{pc} AND NOT user_{uid}
 */
export async function sendToCountryTopicExcluding(
  countryCode: string,
  postalCode: string,
  excludeUid: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const countryTopic = `country_${countryCode}`;

  if (!excludeUid) {
    return sendToCountryTopic(countryCode, postalCode, title, body, data);
  }

  const userTopic = `user_${excludeUid}`;
  let condition: string;

  if (postalCode) {
    const regionTopic = `region_${countryCode}_${postalCode}`;
    condition = `'${countryTopic}' in topics && !('${regionTopic}' in topics) && !('${userTopic}' in topics)`;
  } else {
    condition = `'${countryTopic}' in topics && !('${userTopic}' in topics)`;
  }

  try {
    await getMessaging().send({
      condition,
      notification: { title, body },
      data: data ?? {},
      apns: {
        payload: {
          aps: { sound: "default", badge: 1 },
        },
      },
      android: { priority: "high" as const },
    });
    logger.info(`Country notification sent to ${countryTopic} excluding creator ${excludeUid}`);
  } catch (err) {
    logger.error(`Failed to send to country topic ${countryTopic}:`, err);
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
      android: { priority: "high" as const },
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
