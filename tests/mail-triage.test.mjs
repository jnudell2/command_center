import assert from "node:assert/strict";
import test from "node:test";
import { isDirectlyAddressedToJake, isLikelyAutomatedMail } from "../scripts/mail-triage.mjs";

test("recognizes human mail directed to Jake", () => {
  for (const bodyPreview of [
    "EXTERNAL\r\n\r\nHi Jake!\r\n\r\nIs that okay with your timeline?",
    "Thanks Jake. My encouragement here is for us to be bold.",
    "I appreciate this push.\r\n\r\nGlad to have you on board, Jake!",
  ]) assert.equal(isDirectlyAddressedToJake({ bodyPreview }), true);
});

test("uses Outlook direct-recipient metadata when available", () => {
  assert.equal(isDirectlyAddressedToJake({
    bodyPreview: "Sharing the weekly update.",
    toRecipients: [{ emailAddress: { address: "Jake.Nudell@SerentCapital.com" } }],
  }), true);
});

test("does not mistake quoted headers or generic marketing for a direct address", () => {
  assert.equal(isDirectlyAddressedToJake({ bodyPreview: "Latest product news\r\nFrom: Jake Nudell" }), false);
  assert.equal(isDirectlyAddressedToJake({ bodyPreview: "See how Pendo delivers better user experiences" }), false);
});

test("separates personalized automated mail from human correspondence", () => {
  assert.equal(isLikelyAutomatedMail({
    subject: "UD has joined your meeting",
    bodyPreview: "Hi Jake Nudell, UD has joined your meeting",
    from: { emailAddress: { name: "Zoom", address: "no-reply@zoom.us" } },
  }), true);
  assert.equal(isLikelyAutomatedMail({
    subject: "Agentic AI Summit — Free Registration",
    bodyPreview: "Hi Jake, join the livestream",
    from: { emailAddress: { name: "Berkeley RDI", address: "rdi@berkeley.edu" } },
  }), true);
  assert.equal(isLikelyAutomatedMail({
    subject: "Re: StockIQ Pricing & Packaging VCI Kickoff",
    bodyPreview: "Thanks Jake. My encouragement here is for us to be bold.",
    from: { emailAddress: { name: "Stewart Lynn", address: "stewart.lynn@serentcapital.com" } },
  }), false);
});
