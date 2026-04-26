import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import { config } from "../config.js";

export interface SendEmailParams {
  to?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Mail.Attachment[];
}

let cachedTransport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter {
  if (!config.gmail.appPassword) {
    throw new Error(
      "GMAIL_APP_PASSWORD is not set. Add it to .env.local or your production env."
    );
  }
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: config.gmail.fromEmail,
        pass: config.gmail.appPassword,
      },
    });
  }
  return cachedTransport;
}

/**
 * Send an email via Gmail SMTP.
 *
 * `to` defaults to `config.gmail.toEmail` (which itself defaults to the from
 * address). Both `text` and `html` should be provided for proper multipart
 * delivery; mail clients pick whichever they render best.
 */
export async function sendEmail({
  to,
  subject,
  text,
  html,
  attachments,
}: SendEmailParams): Promise<void> {
  const transport = getTransport();
  await transport.sendMail({
    from: config.gmail.fromEmail,
    to: to ?? config.gmail.toEmail,
    subject,
    text,
    ...(html ? { html } : {}),
    ...(attachments ? { attachments } : {}),
  });
}
