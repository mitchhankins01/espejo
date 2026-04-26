import { config } from "../../src/config.js";
import { sendEmail } from "../../src/email/send.js";

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
  await sendEmail({
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
