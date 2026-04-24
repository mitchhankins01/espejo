import nodemailer from "nodemailer";
import { config } from "../../src/config.js";

export interface SendParams {
  epubPath: string;
  filename: string;
  subject: string;
}

export async function sendToKindle({
  epubPath,
  filename,
  subject,
}: SendParams): Promise<void> {
  if (!config.gmail.appPassword) {
    throw new Error(
      "GMAIL_APP_PASSWORD is not set. Add it to .env.local or run with --no-send."
    );
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: config.gmail.fromEmail,
      pass: config.gmail.appPassword,
    },
  });

  await transporter.sendMail({
    from: config.gmail.fromEmail,
    to: config.gmail.kindleEmail,
    subject,
    text: subject,
    attachments: [
      {
        filename,
        path: epubPath,
        contentType: "application/epub+zip",
      },
    ],
  });
}
