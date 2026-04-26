import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMail = vi.hoisted(() => vi.fn());
const createTransport = vi.hoisted(() =>
  vi.fn().mockReturnValue({ sendMail })
);

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

vi.mock("../../src/config.js", () => ({
  config: {
    gmail: {
      appPassword: "app-pw-here",
      fromEmail: "from@example.com",
      toEmail: "to@example.com",
      kindleEmail: "kindle@example.com",
    },
  },
}));

import { sendEmail } from "../../src/email/send.js";

beforeEach(() => {
  sendMail.mockReset();
  createTransport.mockClear();
});

describe("sendEmail", () => {
  it("calls nodemailer with from/to/subject/text/html", async () => {
    sendMail.mockResolvedValueOnce({ accepted: ["to@example.com"] });
    await sendEmail({
      subject: "Hello",
      text: "plain body",
      html: "<p>html body</p>",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Hello",
      text: "plain body",
      html: "<p>html body</p>",
    });
  });

  it("uses the explicit `to` override when provided", async () => {
    sendMail.mockResolvedValueOnce({});
    await sendEmail({
      to: "other@example.com",
      subject: "X",
      text: "x",
    });
    const args = sendMail.mock.calls[0][0];
    expect(args.to).toBe("other@example.com");
    expect(args.html).toBeUndefined();
  });

  it("forwards attachments when provided", async () => {
    sendMail.mockResolvedValueOnce({});
    await sendEmail({
      subject: "S",
      text: "T",
      attachments: [{ filename: "a.epub", path: "/tmp/a.epub" }],
    });
    expect(sendMail.mock.calls[0][0].attachments).toEqual([
      { filename: "a.epub", path: "/tmp/a.epub" },
    ]);
  });

  it("reuses the transport across multiple sends", async () => {
    sendMail.mockResolvedValue({});
    await sendEmail({ subject: "1", text: "1" });
    await sendEmail({ subject: "2", text: "2" });
    // Both sends went through the same module-level transport singleton.
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});

describe("sendEmail without app password", () => {
  it("throws an actionable error when GMAIL_APP_PASSWORD is empty", async () => {
    vi.resetModules();
    vi.doMock("nodemailer", () => ({
      default: { createTransport: vi.fn() },
    }));
    vi.doMock("../../src/config.js", () => ({
      config: {
        gmail: {
          appPassword: "",
          fromEmail: "from@example.com",
          toEmail: "to@example.com",
          kindleEmail: "kindle@example.com",
        },
      },
    }));
    const { sendEmail: sendEmailFresh } = await import("../../src/email/send.js");
    await expect(
      sendEmailFresh({ subject: "x", text: "y" })
    ).rejects.toThrow(/GMAIL_APP_PASSWORD is not set/);
  });
});
