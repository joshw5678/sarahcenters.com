import { scalarText } from "../shared/contracts.js";
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import type { EmailMessage, EmailRecipient } from "./types.js";
import type { DeliveryRow } from "./rows.js";
interface SendEmailOptions extends EmailMessage { dedupeKey: string; category: string; userId?: string | null; purchaseId?: string | null }
type EmailConfig = Pick<WorkerEnv, "EMAIL_FROM" | "EMAIL_REPLY_TO" | "AWS_SES_CONFIGURATION_SET">;
import { AppError, errorMessage, isRecord, parseJson as parseUnknownJson } from "../shared/contracts.js";
import type { WorkerEnv } from "./types.js";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { normalizeEmail } from "./customer-auth.js";

function escapeHtml(value: unknown) {
  return scalarText(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function publicOrigin(request: Request, env: WorkerEnv) {
  const requestUrl = new URL(request.url);
  if (["localhost", "127.0.0.1", "::1"].includes(requestUrl.hostname)) {
    return requestUrl.origin;
  }
  return scalarText(env.PUBLIC_URL || requestUrl.origin).replace(/\/$/, "");
}

function emailShell(title: string, introduction: string, actionLabel: string, actionUrl: string, footer = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f3f0e8;color:#1a2433;font-family:Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #d8d0bf;border-radius:12px;overflow:hidden">
      <tr><td style="background:#101b2a;color:#d9b567;padding:22px 30px;font:600 20px Georgia,serif;letter-spacing:.08em">S.E. Centers</td></tr>
      <tr><td style="padding:32px 30px">
        <h1 style="margin:0 0 18px;font:600 30px Georgia,serif;color:#101b2a">${escapeHtml(title)}</h1>
        <div style="font-size:16px;line-height:1.65;color:#394455">${introduction}</div>
        <p style="margin:28px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#b88938;color:#fff;text-decoration:none;padding:13px 20px;border-radius:5px;font-weight:700">${escapeHtml(actionLabel)}</a></p>
        ${footer ? `<div style="font-size:14px;line-height:1.55;color:#687283">${footer}</div>` : ""}
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function createAwsSesInput(env: EmailConfig, message: EmailMessage): SendEmailCommandInput {
  if (!env.EMAIL_FROM) throw new AppError("Email delivery is not configured.");
  const input: SendEmailCommandInput = {
    FromEmailAddress: env.EMAIL_FROM,
    Destination: {
      ToAddresses: [message.to],
    },
    Content: {
      Simple: {
        Subject: {
          Charset: "UTF-8",
          Data: message.subject,
        },
        Body: {
          Html: {
            Charset: "UTF-8",
            Data: message.html,
          },
          Text: {
            Charset: "UTF-8",
            Data: message.text,
          },
        },
      },
    },
  };
  const replyTo = scalarText(env.EMAIL_REPLY_TO || "").trim();
  if (replyTo) input.ReplyToAddresses = [normalizeEmail(replyTo)];
  const configurationSet = scalarText(env.AWS_SES_CONFIGURATION_SET || "").trim();
  if (configurationSet) input.ConfigurationSetName = configurationSet;
  return input;
}

async function sendWithAwsSes(env: WorkerEnv, message: EmailMessage) {
  const region = scalarText(env.AWS_REGION || "").trim();
  const accessKeyId = scalarText(env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = scalarText(env.AWS_SECRET_ACCESS_KEY || "");
  const sessionToken = scalarText(env.AWS_SESSION_TOKEN || "").trim();
  if (!region || !/^[a-z0-9-]{5,32}$/.test(region)) {
    throw new AppError("AWS SES region is not configured.");
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new AppError("AWS SES credentials are not configured.");
  }

  const client = new SESv2Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  });
  try {
    const result = await client.send(
      new SendEmailCommand(createAwsSesInput(env, message))
    );
    return { id: result.MessageId || "" };
  } finally {
    client.destroy();
  }
}

async function providerSend(env: WorkerEnv, message: EmailMessage, dedupeKey: string) {
  if (env.EMAIL_SENDER && typeof env.EMAIL_SENDER.send === "function") {
    return env.EMAIL_SENDER.send({ ...message, dedupeKey });
  }
  if (!env.EMAIL_FROM) {
    throw new AppError("Email delivery is not configured.");
  }

  const provider = scalarText(env.EMAIL_PROVIDER || "resend").toLowerCase();
  if (provider === "aws-ses" || provider === "ses") {
    return sendWithAwsSes(env, message);
  }
  if (!env.EMAIL_API_KEY) {
    throw new AppError("Email delivery is not configured.");
  }

  let endpoint;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body;
  if (provider === "postmark") {
    endpoint = env.EMAIL_API_URL || "https://api.postmarkapp.com/email";
    headers["X-Postmark-Server-Token"] = env.EMAIL_API_KEY;
    body = {
      From: env.EMAIL_FROM,
      To: message.to,
      Subject: message.subject,
      HtmlBody: message.html,
      TextBody: message.text,
      MessageStream: env.EMAIL_MESSAGE_STREAM || "outbound",
      Metadata: { dedupeKey },
    };
  } else if (provider === "sendgrid") {
    endpoint = env.EMAIL_API_URL || "https://api.sendgrid.com/v3/mail/send";
    headers.Authorization = `Bearer ${env.EMAIL_API_KEY}`;
    body = {
      personalizations: [{ to: [{ email: message.to }], custom_args: { dedupeKey } }],
      from: { email: env.EMAIL_FROM },
      subject: message.subject,
      content: [
        { type: "text/plain", value: message.text },
        { type: "text/html", value: message.html },
      ],
    };
  } else if (provider === "resend") {
    endpoint = env.EMAIL_API_URL || "https://api.resend.com/emails";
    headers.Authorization = `Bearer ${env.EMAIL_API_KEY}`;
    headers["Idempotency-Key"] = dedupeKey;
    body = {
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
  } else {
    throw new AppError(`Unsupported email provider: ${provider}.`);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new AppError(`Email provider returned HTTP ${response.status}.`);
  }
  try {
    const data: unknown = responseText ? parseUnknownJson(responseText) : {};
    const id = isRecord(data) && typeof data.id === "string" ? data.id : isRecord(data) && typeof data.MessageID === "string" ? data.MessageID : "";
    return { id: id || response.headers.get("x-message-id") || "" };
  } catch {
    return { id: response.headers.get("x-message-id") || "" };
  }
}

export async function sendEmailOnce(
  env: WorkerEnv,
  { dedupeKey, category, to, subject, html, text, userId = null, purchaseId = null }: SendEmailOptions
) {
  const recipient = normalizeEmail(to);
  const now = new Date().toISOString();
  const id = `mail_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO email_deliveries
       (id, dedupe_key, category, user_id, purchase_id, recipient_normalized,
        status, attempt_count, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, '', ?, ?)`
  )
    .bind(id, dedupeKey, category, userId, purchaseId, recipient, now, now)
    .run();
  const delivery = await env.DB.prepare(
    "SELECT * FROM email_deliveries WHERE dedupe_key = ?"
  )
    .bind(dedupeKey)
    .first<DeliveryRow>();
  if (delivery?.status === "sent") return { sent: true, duplicate: true };

  await env.DB.prepare(
    `UPDATE email_deliveries
     SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?
     WHERE dedupe_key = ? AND status <> 'sent'`
  )
    .bind(now, dedupeKey)
    .run();
  try {
    const result = await providerSend(env, { to: recipient, subject, html, text }, dedupeKey);
    const sentAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE email_deliveries
       SET status = 'sent', provider_message_id = ?, last_error = '',
           updated_at = ?, sent_at = ?
       WHERE dedupe_key = ?`
    )
      .bind(scalarText(result?.id || "").slice(0, 255), sentAt, sentAt, dedupeKey)
      .run();
    return { sent: true };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE email_deliveries
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE dedupe_key = ?`
    )
      .bind(errorMessage(error, "Email delivery failed.").slice(0, 300), new Date().toISOString(), dedupeKey)
      .run();
    return { sent: false };
  }
}

export async function sendVerificationEmail(request: Request, env: WorkerEnv, user: EmailRecipient, token: string, tokenId: string) {
  const url = `${publicOrigin(request, env)}/verify-email.html#token=${encodeURIComponent(token)}`;
  const name = escapeHtml(user.displayName || "reader");
  return sendEmailOnce(env, {
    dedupeKey: `verify:${tokenId}`,
    category: "email_verification",
    to: user.email,
    userId: user.id,
    subject: "Verify your Tartarian Chronicles account",
    html: emailShell(
      "Verify your email",
      `<p>Hello ${name},</p><p>Confirm this email address to activate purchases and secure downloads for your Tartarian Chronicles account.</p>`,
      "Verify Email",
      url,
      "This single-use link expires in 24 hours. If you did not create this account, you can ignore this message."
    ),
    text: `Hello ${user.displayName || "reader"},\n\nVerify your email to activate your account: ${url}\n\nThis single-use link expires in 24 hours.`,
  });
}

export async function sendPasswordResetEmail(request: Request, env: WorkerEnv, user: EmailRecipient, token: string, tokenId: string) {
  const url = `${publicOrigin(request, env)}/reset-password.html#token=${encodeURIComponent(token)}`;
  const name = escapeHtml(user.displayName || "reader");
  return sendEmailOnce(env, {
    dedupeKey: `password-reset:${tokenId}`,
    category: "password_reset",
    to: user.email,
    userId: user.id,
    subject: "Reset your Tartarian Chronicles password",
    html: emailShell(
      "Reset your password",
      `<p>Hello ${name},</p><p>We received a request to reset the password for your account.</p>`,
      "Reset Password",
      url,
      "This single-use link expires in one hour. If you did not request it, your password has not changed."
    ),
    text: `Reset your password: ${url}\n\nThis single-use link expires in one hour. If you did not request it, ignore this email.`,
  });
}

export async function sendClaimEmail(request: Request, env: WorkerEnv, purchase: { id: string; pendingEmail: string }, token: string, tokenId: string, bookTitles: string[]) {
  const url = `${publicOrigin(request, env)}/claim-purchase.html#token=${encodeURIComponent(token)}`;
  const books = bookTitles.map(escapeHtml).join(", ");
  return sendEmailOnce(env, {
    dedupeKey: `purchase-claim:${tokenId}`,
    category: "purchase_claim",
    to: purchase.pendingEmail,
    purchaseId: purchase.id,
    subject: "Claim your Tartarian Chronicles purchase",
    html: emailShell(
      "Your purchase is ready to claim",
      `<p>Payment succeeded for ${books}.</p><p>Create or sign in to an account with this email address, verify it, and claim lifetime access to the purchased files.</p>`,
      "Claim Purchase",
      url,
      "This single-use claim link expires in seven days. No password has been created for you."
    ),
    text: `Payment succeeded for ${bookTitles.join(", ")}.\n\nClaim the purchase: ${url}\n\nThis single-use link expires in seven days.`,
  });
}

export async function sendPurchaseConfirmation(request: Request, env: WorkerEnv, user: EmailRecipient, purchase: { id: string }, bookTitles: string[], formats: string[]) {
  const url = `${publicOrigin(request, env)}/library.html`;
  const name = escapeHtml(user.displayName || "reader");
  const books = bookTitles.map(escapeHtml).join(", ");
  const available = formats.includes("pdf") ? "EPUB and PDF" : "EPUB";
  return sendEmailOnce(env, {
    dedupeKey: `purchase-confirmation:${purchase.id}`,
    category: "purchase_confirmation",
    to: user.email,
    userId: user.id,
    purchaseId: purchase.id,
    subject: "Your Tartarian Chronicles books are ready",
    html: emailShell(
      "Your books are ready",
      `<p>Hello ${name},</p><p>Payment succeeded for ${books}. Your ${escapeHtml(available)} files are now available from My Library.</p>`,
      "Open My Library",
      url,
      "Sign in with this email address whenever you want to download your purchased editions."
    ),
    text: `Hello ${user.displayName || "reader"},\n\nPayment succeeded for ${bookTitles.join(", ")}. Your ${available} files are available in My Library: ${url}`,
  });
}
