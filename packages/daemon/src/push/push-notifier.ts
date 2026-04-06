import { createLogger } from "@teleprompter/protocol";

const log = createLogger("PushNotifier");

const NOTIFY_EVENTS = new Set(["Elicitation", "PermissionRequest"]);

const EVENT_MESSAGES: Record<string, { title: string; body: string }> = {
  Elicitation: {
    title: "Response needed",
    body: "Claude is waiting for your answer",
  },
  PermissionRequest: {
    title: "Permission needed",
    body: "Tool permission approval required",
  },
};

interface RecordInfo {
  sid: string;
  kind: string;
  name?: string;
  ns?: string;
}

export interface PushNotifierDeps {
  sendPush: (
    frontendId: string,
    token: string,
    title: string,
    body: string,
    data: { sid: string; event: string },
  ) => void;
}

interface TokenEntry {
  token: string;
  platform: "ios" | "android";
}

export class PushNotifier {
  private tokens = new Map<string, TokenEntry>();
  private deps: PushNotifierDeps;

  constructor(deps: PushNotifierDeps) {
    this.deps = deps;
  }

  registerToken(
    frontendId: string,
    token: string,
    platform: "ios" | "android",
  ): void {
    this.tokens.set(frontendId, { token, platform });
    log.info(`registered push token for frontend ${frontendId} (${platform})`);
  }

  unregisterToken(frontendId: string): void {
    this.tokens.delete(frontendId);
    log.info(`unregistered push token for frontend ${frontendId}`);
  }

  onRecord(rec: RecordInfo): void {
    if (rec.kind !== "event") return;
    if (!rec.name || !NOTIFY_EVENTS.has(rec.name)) return;

    const msg = EVENT_MESSAGES[rec.name];
    if (!msg) return;

    for (const [frontendId, entry] of this.tokens) {
      log.info(
        `sending push notification to ${frontendId} for event ${rec.name} sid=${rec.sid}`,
      );
      this.deps.sendPush(frontendId, entry.token, msg.title, msg.body, {
        sid: rec.sid,
        event: rec.name,
      });
    }
  }
}
