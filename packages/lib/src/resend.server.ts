import nodemailer from "nodemailer";
import type {
  CreateEmailOptions,
  CreateEmailRequestOptions,
  CreateEmailResponse
} from "resend";
import { Resend } from "resend";

function isSmtpConfigured(): boolean {
  return Boolean(
    process.env.MAIL_HOST &&
      process.env.MAIL_USERNAME &&
      process.env.MAIL_PASSWORD
  );
}

function getSmtpTransporter() {
  const port = Number.parseInt(process.env.MAIL_PORT ?? "587", 10);
  const enc = (process.env.MAIL_ENCRYPTION ?? "tls").toLowerCase();
  const secure = enc === "ssl" || port === 465;
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port,
    secure,
    auth: {
      user: process.env.MAIL_USERNAME,
      pass: process.env.MAIL_PASSWORD
    },
    ...(!secure ? { requireTLS: true } : {})
  });
}

let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!resendClient) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error(
        "RESEND_API_KEY is not set. Configure Resend, or set MAIL_HOST, MAIL_USERNAME, and MAIL_PASSWORD for SMTP."
      );
    }
    resendClient = new Resend(key);
  }
  return resendClient;
}

export async function sendEmail(
  payload: CreateEmailOptions,
  options?: CreateEmailRequestOptions
): Promise<CreateEmailResponse> {
  if (process.env.DISABLE_EMAIL === "true") {
    console.log("[email disabled]", payload.from, payload.to, payload.subject);
    return { error: null, data: null };
  }

  if (isSmtpConfigured()) {
    try {
      const transporter = getSmtpTransporter();
      const to = Array.isArray(payload.to) ? payload.to.join(", ") : payload.to;
      const info = await transporter.sendMail({
        from: payload.from,
        to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        replyTo: payload.reply_to
      });
      return {
        data: { id: info.messageId ?? "smtp" },
        error: null
      };
    } catch (e) {
      const err = e as Error;
      console.error("[smtp sendEmail]", err);
      return {
        data: null,
        error: { message: err.message } as CreateEmailResponse["error"]
      };
    }
  }

  if (process.env.DISABLE_RESEND === "true") {
    console.log(payload, options);
    return {
      error: null,
      data: null
    };
  }

  return getResendClient().emails.send(payload, options);
}

/** Same API as `new Resend().emails.send` for callers that import `resend` (e.g. onboard task). */
export const resend = {
  emails: {
    send: (
      payload: CreateEmailOptions,
      options?: CreateEmailRequestOptions
    ): Promise<CreateEmailResponse> => sendEmail(payload, options)
  }
};
