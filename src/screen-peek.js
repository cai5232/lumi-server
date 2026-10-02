import { timingSafeEqual } from "node:crypto";

export function screenPeekConfigured(env = process.env) {
  return Boolean(env.LUMI_SCREEN_PEEK_TOKEN && env.LUMI_SCREEN_PEEK_SMTP_HOST &&
    env.LUMI_SCREEN_PEEK_SMTP_USER && env.LUMI_SCREEN_PEEK_SMTP_PASSWORD &&
    env.LUMI_SCREEN_PEEK_EMAIL_TO && env.LUMI_SCREEN_PEEK_EMAIL_SUBJECT);
}

export function screenPeekAuthorized(header, env = process.env) {
  const expected = String(env.LUMI_SCREEN_PEEK_TOKEN || "");
  const supplied = String(header || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function screenImageType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  return null;
}

export async function sendScreenPeekTrigger(env = process.env) {
  if (!screenPeekConfigured(env)) throw new Error("screen peek mail is not configured");
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(env.LUMI_SCREEN_PEEK_SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: env.LUMI_SCREEN_PEEK_SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: env.LUMI_SCREEN_PEEK_SMTP_USER, pass: env.LUMI_SCREEN_PEEK_SMTP_PASSWORD },
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 20_000
  });
  try {
    await transport.sendMail({
      from: env.LUMI_SCREEN_PEEK_EMAIL_FROM || env.LUMI_SCREEN_PEEK_SMTP_USER,
      to: env.LUMI_SCREEN_PEEK_EMAIL_TO,
      subject: env.LUMI_SCREEN_PEEK_EMAIL_SUBJECT,
      text: `Lumi screen peek ${Date.now()}`
    });
  } finally {
    transport.close();
  }
}
