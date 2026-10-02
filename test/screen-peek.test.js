import assert from "node:assert/strict";
import { test } from "node:test";
import { screenImageType, screenPeekAuthorized, screenPeekConfigured } from "../src/screen-peek.js";

test("screen peek requires complete mail setup and a separate upload token", () => {
  const env = {
    LUMI_SCREEN_PEEK_TOKEN: "private-upload-token",
    LUMI_SCREEN_PEEK_SMTP_HOST: "smtp.example.test",
    LUMI_SCREEN_PEEK_SMTP_USER: "sender@example.test",
    LUMI_SCREEN_PEEK_SMTP_PASSWORD: "app-password",
    LUMI_SCREEN_PEEK_EMAIL_TO: "recipient@example.test",
    LUMI_SCREEN_PEEK_EMAIL_SUBJECT: "private-subject"
  };
  assert.equal(screenPeekConfigured(env), true);
  assert.equal(screenPeekConfigured({ ...env, LUMI_SCREEN_PEEK_EMAIL_SUBJECT: "" }), false);
  assert.equal(screenPeekAuthorized("Bearer private-upload-token", env), true);
  assert.equal(screenPeekAuthorized("Bearer wrong-token", env), false);
  assert.equal(screenPeekAuthorized("Bearer private-upload-token", {}), false);
});

test("screen peek accepts only JPEG and PNG image bytes", () => {
  assert.equal(screenImageType(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])), "image/jpeg");
  assert.equal(screenImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])), "image/png");
  assert.equal(screenImageType(Buffer.from("not an image")), null);
  assert.equal(screenImageType(Buffer.from([0xff, 0xd8, 0x00])), null);
});
